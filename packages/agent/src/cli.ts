#!/usr/bin/env node
/**
 * The command line — terminal analysis, and the CI gate (REQUIREMENTS.md F5).
 *
 * The gate is the feature teams pay for, and it is a small increment over the
 * engine that already exists: plan a query, compare the result to a committed
 * baseline, fail the build when it got worse.
 *
 * Two deliberate choices:
 *
 *   1. **Baselines record plan shape, not timing.** Committed baselines get
 *      compared on someone else's machine against a different dataset, so
 *      wall-clock is meaningless. Access methods and planner cost are what
 *      travel.
 *
 *   2. **The gate defaults to plan-only (no ANALYZE).** A CI job should not
 *      execute arbitrary queries against anything, and plan shape is what a
 *      regression gate is actually checking.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { analyze, diffPlans, narratePlan, suggestIndexes, type QueryPlan } from '@query-not/core';

import { configFromEnv, Database, describeDbError } from './db.ts';
import { analyzeQuery, runExplain, whatIfIndex } from './explain.ts';
import { analyzeRewrites, initParser } from './rewrite.ts';
import { fingerprint } from './safety.ts';

const RESET = '[0m';
const BOLD = '[1m';
const DIM = '[2m';
const RED = '[31m';
const GREEN = '[32m';
const YELLOW = '[33m';

const colour = process.stdout.isTTY && !process.env['NO_COLOR'];
const c = (code: string, text: string) => (colour ? `${code}${text}${RESET}` : text);

interface Baseline {
  version: 1;
  /** Keyed by query name. */
  queries: Record<
    string,
    {
      sql: string;
      fingerprint: string;
      totalCost: number;
      /** Access methods, in plan order — the part that travels between machines. */
      accessMethods: string[];
      rootNode: string;
      recordedAt: string;
    }
  >;
}

function usage(): string {
  return `${BOLD}querynot${RESET} — analyse Postgres queries, and gate plan regressions in CI

${BOLD}Usage${RESET}
  querynot analyse <file|-->              Analyse a query and print the findings
  querynot rewrite <file|-->              Structural advice from the SQL alone (no database)
  querynot baseline <queries.json>        Record plan baselines for the CI gate
  querynot ci <queries.json>              Check plans against the baseline; non-zero on regression

${BOLD}Options${RESET}
  --analyze              Execute the query to collect real timings (analyse only)
  --baseline <path>      Baseline file (default .querynot/baseline.json)
  --max-cost-increase <n>  Fractional cost rise allowed before failing (default 0.20)
  --json                 Machine-readable output
  --help                 This

${BOLD}Environment${RESET}
  QUERYNOT_DATABASE_URL  Connection string (required except for 'rewrite')

${BOLD}Query file format${RESET} ${DIM}(JSON)${RESET}
  { "checkout": "SELECT ...", "report": "SELECT ..." }
`;
}

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  // A leading flag means no command was given — `querynot --help` should print
  // help, not complain about an unknown command called "--help".
  const first = argv[0];
  const command = first && !first.startsWith('--') ? first : '';
  const rest = command ? argv.slice(1) : argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] as string;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }
  return { command, positional, flags };
}

async function readSource(path: string | undefined): Promise<string> {
  if (!path || path === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }
  return readFile(resolve(path), 'utf8');
}

/** Access methods in plan order — stable across machines, unlike timings. */
function accessMethodsOf(plan: QueryPlan): string[] {
  return plan.nodes
    .filter((n) => n.nodeType.endsWith('Scan') || n.nodeType.endsWith('Join'))
    .map((n) => `${n.nodeType}${n.relation ? ` on ${n.relation}` : ''}${n.indexName ? ` via ${n.indexName}` : ''}`);
}

async function loadQueries(path: string): Promise<Record<string, string>> {
  const raw = await readFile(resolve(path), 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Query file must be a JSON object of { name: sql }.');
  }
  const out: Record<string, string> = {};
  for (const [name, sql] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof sql !== 'string') throw new Error(`Query "${name}" must be a string.`);
    out[name] = sql;
  }
  return out;
}

async function cmdAnalyse(args: Args): Promise<number> {
  const sql = (await readSource(args.positional[0])).trim();
  if (!sql) {
    console.error('No SQL provided.');
    return 2;
  }

  const db = new Database(configFromEnv());
  try {
    await initParser().catch(() => undefined);
    const result = await analyzeQuery(db, sql, { analyze: args.flags['analyze'] === true });

    if (args.flags['json']) {
      console.log(JSON.stringify(result, null, 2));
      return result.findings.some((f) => f.severity === 'critical') ? 1 : 0;
    }

    console.log(`\n${c(BOLD, 'Summary')}`);
    console.log(`  ${result.narration}\n`);

    if (result.findings.length > 0) {
      console.log(c(BOLD, 'Findings'));
      for (const f of result.findings) {
        const mark =
          f.severity === 'critical' ? c(RED, '✗') : f.severity === 'warning' ? c(YELLOW, '!') : c(DIM, 'i');
        console.log(`  ${mark} ${f.title}`);
        console.log(`    ${c(DIM, f.detail)}`);
        if (f.suggestion) console.log(`    ${c(DIM, `→ ${f.suggestion}`)}`);
      }
      console.log();
    }

    if (result.indexSuggestions.length > 0) {
      console.log(c(BOLD, 'Index suggestions'));
      for (const s of result.indexSuggestions) {
        console.log(`  ${s.ddl}  ${c(DIM, `(confidence: ${s.confidence})`)}`);
        if (s.caveat) console.log(`    ${c(YELLOW, `⚠ ${s.caveat}`)}`);
      }
      console.log();
    }

    if (result.rewrites.length > 0) {
      console.log(c(BOLD, 'Rewrites'));
      for (const r of result.rewrites) {
        console.log(`  ${r.severity === 'critical' ? c(RED, '✗') : c(YELLOW, '!')} ${r.title}`);
        console.log(`    ${c(DIM, `→ ${r.suggestion}`)}`);
        if (r.semanticChange) console.log(`    ${c(YELLOW, `⚠ Changes results: ${r.semanticChange}`)}`);
      }
      console.log();
    }

    return result.findings.some((f) => f.severity === 'critical') ? 1 : 0;
  } finally {
    await db.close();
  }
}

async function cmdRewrite(args: Args): Promise<number> {
  const sql = (await readSource(args.positional[0])).trim();
  await initParser();
  const rewrites = analyzeRewrites(sql);

  if (args.flags['json']) {
    console.log(JSON.stringify({ rewrites }, null, 2));
  } else if (rewrites.length === 0) {
    console.log(c(GREEN, '\n✓ No structural problems in the SQL.\n'));
  } else {
    console.log();
    for (const r of rewrites) {
      const mark = r.severity === 'critical' ? c(RED, '✗') : r.severity === 'warning' ? c(YELLOW, '!') : c(DIM, 'i');
      console.log(`${mark} ${c(BOLD, r.title)}`);
      console.log(`  ${r.detail}`);
      console.log(`  ${c(DIM, `→ ${r.suggestion}`)}`);
      if (r.semanticChange) console.log(`  ${c(YELLOW, `⚠ Changes results: ${r.semanticChange}`)}`);
      console.log();
    }
  }
  return rewrites.some((r) => r.severity === 'critical') ? 1 : 0;
}

async function cmdBaseline(args: Args): Promise<number> {
  const queriesPath = args.positional[0];
  if (!queriesPath) {
    console.error('Provide a query file: querynot baseline queries.json');
    return 2;
  }
  const queries = await loadQueries(queriesPath);
  const baselinePath = resolve(String(args.flags['baseline'] ?? '.querynot/baseline.json'));

  const db = new Database(configFromEnv());
  const baseline: Baseline = { version: 1, queries: {} };

  try {
    for (const [name, sql] of Object.entries(queries)) {
      // Plan only, never execute: recording a baseline should not run
      // arbitrary statements against whatever CI is pointed at.
      const plan = await runExplain(db, sql, { analyze: false });
      baseline.queries[name] = {
        sql,
        fingerprint: fingerprint(sql),
        totalCost: plan.totalCost,
        accessMethods: accessMethodsOf(plan),
        rootNode: plan.root.nodeType,
        recordedAt: new Date().toISOString(),
      };
      console.log(`  ${c(GREEN, '✓')} ${name} ${c(DIM, `cost ${plan.totalCost.toFixed(0)}`)}`);
    }

    await mkdir(dirname(baselinePath), { recursive: true });
    await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    console.log(`\nBaseline written to ${baselinePath}`);
    console.log(c(DIM, 'Commit it — the gate compares against this.\n'));
    return 0;
  } finally {
    await db.close();
  }
}

interface GateFailure {
  name: string;
  reason: string;
  detail: string;
}

async function cmdCi(args: Args): Promise<number> {
  const queriesPath = args.positional[0];
  if (!queriesPath) {
    console.error('Provide a query file: querynot ci queries.json');
    return 2;
  }

  const baselinePath = resolve(String(args.flags['baseline'] ?? '.querynot/baseline.json'));
  if (!existsSync(baselinePath)) {
    console.error(`No baseline at ${baselinePath}. Record one first: querynot baseline ${queriesPath}`);
    return 2;
  }

  const maxIncrease = Number(args.flags['max-cost-increase'] ?? 0.2);
  const queries = await loadQueries(queriesPath);
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as Baseline;

  const db = new Database(configFromEnv());
  const failures: GateFailure[] = [];
  const results: Array<{ name: string; ok: boolean; costBefore: number | null; costAfter: number }> = [];

  try {
    await initParser().catch(() => undefined);

    for (const [name, sql] of Object.entries(queries)) {
      const plan = await runExplain(db, sql, { analyze: false });
      const before = baseline.queries[name];
      const methods = accessMethodsOf(plan);

      results.push({ name, ok: true, costBefore: before?.totalCost ?? null, costAfter: plan.totalCost });

      // A new query has nothing to regress against; report it rather than
      // silently passing it.
      if (!before) {
        console.log(`  ${c(YELLOW, '+')} ${name} ${c(DIM, 'new — no baseline, not checked')}`);
        continue;
      }

      // An access method disappearing is the regression that matters most:
      // it means an index stopped being used.
      const lost = before.accessMethods.filter((m) => !methods.includes(m) && /via /.test(m));
      const costChange = before.totalCost > 0 ? (plan.totalCost - before.totalCost) / before.totalCost : 0;

      const problems: string[] = [];
      if (lost.length > 0) problems.push(`no longer uses ${lost.join(', ')}`);
      if (costChange > maxIncrease) {
        problems.push(
          `estimated cost rose ${(costChange * 100).toFixed(0)}% (${before.totalCost.toFixed(0)} → ${plan.totalCost.toFixed(0)})`,
        );
      }
      if (before.rootNode !== plan.root.nodeType && lost.length === 0 && costChange > maxIncrease) {
        problems.push(`plan shape changed: ${before.rootNode} → ${plan.root.nodeType}`);
      }

      if (problems.length > 0) {
        failures.push({ name, reason: problems[0] as string, detail: problems.join('; ') });
        results[results.length - 1]!.ok = false;
        console.log(`  ${c(RED, '✗')} ${name}`);
        for (const p of problems) console.log(`    ${c(DIM, p)}`);
      } else {
        console.log(`  ${c(GREEN, '✓')} ${name} ${c(DIM, `cost ${plan.totalCost.toFixed(0)}`)}`);
      }
    }

    if (args.flags['json']) {
      console.log(JSON.stringify({ failures, results }, null, 2));
    }

    console.log();
    if (failures.length > 0) {
      console.log(c(RED, `${failures.length} plan regression${failures.length === 1 ? '' : 's'}.`));
      console.log(
        c(DIM, 'If the change is intended, re-record the baseline: querynot baseline ' + queriesPath),
      );
      console.log();
      return 1;
    }
    console.log(c(GREEN, 'No plan regressions.\n'));
    return 0;
  } finally {
    await db.close();
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.command || args.flags['help'] || args.command === 'help') {
    console.log(usage());
    return args.command ? 0 : 2;
  }

  switch (args.command) {
    case 'analyse':
    case 'analyze':
      return cmdAnalyse(args);
    case 'rewrite':
      return cmdRewrite(args);
    case 'baseline':
      return cmdBaseline(args);
    case 'ci':
      return cmdCi(args);
    default:
      console.error(`Unknown command "${args.command}".\n`);
      console.log(usage());
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    const { message, hint } = describeDbError(err);
    console.error(`\n${c(RED, 'Error:')} ${message}`);
    if (hint) console.error(c(DIM, hint));
    console.error();
    process.exit(2);
  });
