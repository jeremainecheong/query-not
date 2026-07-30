/**
 * The agent's HTTP surface.
 *
 * Request/response over the IR, not a one-way metrics push — because the
 * what-if loop needs a live connection and only the agent has one
 * (REQUIREMENTS.md §6.2).
 */

import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { configFromEnv, Database, describeDbError } from './db.ts';
import {
  AgentError,
  analyzeQuery,
  verifySuggestions,
  whatIfIndex,
  whatIfRewrite,
  whatIfSettings,
  whatIfStatistics,
} from './explain.ts';
import { fingerprint, TUNABLE_GUCS } from './safety.ts';
import { analyzeRewrites, initParser, SqlParseError } from './rewrite.ts';
import { Store } from './store.ts';
import { buildHistory } from './history.ts';
import { listIndexInventory, proveDropIndex } from './dropindex.ts';
import {
  collectWorkload,
  deltaWorkload,
  isExplainable,
  probeWorkload,
  rankWorkload,
  type WorkloadEntry,
} from './workload.ts';

const config = configFromEnv();
const db = new Database(config);

/**
 * The statistics sandbox — a second, opt-in connection with DDL rights on a
 * disposable copy. The target pool above stays read-only by design; this one
 * exists because CREATE STATISTICS cannot be hypothetical. One connection on
 * purpose: an in-transaction ANALYZE holds ShareUpdateExclusive on the table
 * until rollback, so proofs serialise instead of stacking behind each other's
 * locks.
 */
const sandbox = config.sandboxUrl
  ? new Database({
      ...config,
      connectionString: config.sandboxUrl,
      maxConnections: 1,
      applicationName: 'query-not-sandbox',
    })
  : null;

const app = express();

// The rewrite advisor's parser loads a wasm module once at startup. Tracked as
// a capability rather than assumed, so a load failure degrades that one feature
// instead of taking the agent down.
let parserReady = false;

/**
 * Persistence lives with the agent, inside the customer's network.
 *
 * Single-tenant by design, so there is no auth layer here: whoever can reach
 * this process is already authorised by the network. Adding accounts would buy
 * no access control that does not already exist.
 */
const store = new Store(process.env['QUERYNOT_STORE_PATH'] ?? './.querynot/store.db');

app.use(cors());
app.use(express.json({ limit: '1mb' }));

function fail(res: express.Response, err: unknown): void {
  if (err instanceof AgentError) {
    res.status(err.status).json({ error: err.message, hint: err.hint });
    return;
  }
  const { message, hint } = describeDbError(err);
  console.error('[agent]', message);
  res.status(400).json({ error: message, hint });
}

function requireSql(body: unknown): string {
  const sql = (body as { sql?: unknown })?.sql;
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    throw new AgentError('Provide a "sql" string.');
  }
  return sql;
}

app.get('/api/health', async (_req, res) => {
  const probe = await db.probe();

  // The sandbox is probed fresh alongside the target. canDdl is the bit the
  // statistics proof actually needs — probe() already measures exactly it.
  const sandboxProbe = sandbox ? await sandbox.probe() : null;
  const sandboxHealth = sandboxProbe
    ? {
        configured: true,
        connected: sandboxProbe.connected,
        database: sandboxProbe.database,
        canDdl: sandboxProbe.connected && !sandboxProbe.readOnlyRole,
        error: sandboxProbe.error,
      }
    : null;

  res.json({
    agent: 'ok',
    statementTimeoutMs: config.statementTimeoutMs,
    tunableSettings: [...TUNABLE_GUCS],
    store: store.stats(),
    workload: { snapshots: store.workloadSnapshotCount() },
    database: probe,
    sandbox: sandboxHealth,
    // Surfaced so the UI can warn rather than silently offering a broken feature.
    capabilities: {
      whatIfIndex: probe.hypopgInstalled,
      whatIfSettings: probe.connected,
      measuredAnalysis: probe.connected,
      rewriteAdvisor: parserReady,
      // The one what-if that can be executed rather than just costed — it
      // needs a connection and the parser, and no extension at all.
      proveRewrite: probe.connected && parserReady,
      // Hiding an existing index needs hypopg 1.4+ (hypopg_hide_index),
      // probed by function existence rather than version-string parsing. The
      // /api/indexes listing itself needs no extension; only proving does.
      dropIndex: probe.hypopgInstalled && probe.hypopgHideIndex,
      // Statistics proofs run real (rolled-back) DDL, so they need the
      // opt-in sandbox with a role that can write, plus the parser for the
      // server-side candidate re-derivation.
      proveStatistics: (sandboxHealth?.canDdl ?? false) && parserReady,
      persistence: true,
    },
  });
});

/**
 * Rewrite analysis on its own — no database needed.
 *
 * Useful in CI and in an editor, where you want the structural advice without
 * a connection to anything.
 */
app.post('/api/rewrite', async (req, res) => {
  try {
    const sql = requireSql(req.body);
    if (!parserReady) {
      throw new AgentError('The SQL parser failed to load; rewrite analysis is unavailable.', null, 503);
    }
    res.json({ rewrites: analyzeRewrites(sql) });
  } catch (err) {
    if (err instanceof SqlParseError) {
      res.status(400).json({
        error: err.message,
        hint: err.cursorPosition !== null ? `Parser stopped at character ${err.cursorPosition}.` : null,
      });
      return;
    }
    fail(res, err);
  }
});

/**
 * Explain and analyse one query.
 *
 * Every run is recorded, not only explicitly saved ones — plan history is only
 * useful if it accumulates without anyone remembering to press save. The slug
 * comes back so the result is immediately shareable.
 */
app.post('/api/analyze', async (req, res) => {
  try {
    const sql = requireSql(req.body);
    const shouldAnalyze = req.body?.analyze === true;
    const analysis = await analyzeQuery(db, sql, { analyze: shouldAnalyze });

    let slug: string | null = null;
    try {
      slug = store.recordAnalysis({
        fingerprint: analysis.fingerprint,
        sql,
        analyzed: analysis.plan.analyzed,
        payload: analysis,
        totalMs: analysis.plan.totalMs,
        totalWorkMs: analysis.plan.totalWorkMs,
        totalCost: analysis.plan.totalCost,
      });
    } catch (err) {
      // A storage failure must not cost the user their analysis.
      console.warn('[agent] could not record analysis:', err instanceof Error ? err.message : err);
    }

    res.json({ ...analysis, slug });
  } catch (err) {
    fail(res, err);
  }
});

// ── Persistence ──────────────────────────────────────────────────────────────

/** A previously recorded analysis, by slug — this is what a shared link opens. */
app.get('/api/analysis/:slug', (req, res) => {
  const record = store.getAnalysis(req.params.slug);
  if (!record) {
    res.status(404).json({
      error: 'No analysis with that id.',
      hint: 'Links expire when history is pruned — the 50 most recent runs per query are kept.',
    });
    return;
  }
  res.json({
    ...(record.payload as object),
    slug: record.slug,
    createdAt: record.createdAt,
    sql: record.sql,
  });
});

app.get('/api/analyses', (req, res) => {
  res.json({ analyses: store.recentAnalyses(Number(req.query['limit'] ?? 25)) });
});

/**
 * One row per distinct query, with how many times its plan changed.
 *
 * The regression count comes from the same buildHistory the detail page uses,
 * so the number in the list and the entries on the page cannot disagree.
 */
app.get('/api/queries', (_req, res) => {
  const groups = store.queryGroups().map((g) => ({
    ...g,
    regressions: buildHistory(store, g.fingerprint).regressions.filter((r) => r.worse).length,
  }));
  // Queries whose plans have moved matter more than ones that have not.
  groups.sort((a, b) => b.regressions - a.regressions || b.lastSeen.localeCompare(a.lastSeen));
  res.json({ queries: groups });
});

/** Plan history for one query, with the points where it changed shape. */
app.get('/api/history/:fingerprint', (req, res) => {
  res.json(buildHistory(store, req.params.fingerprint));
});

// ── Workload ─────────────────────────────────────────────────────────────────

/**
 * Take a snapshot of the cumulative counters.
 *
 * Called on a timer by the agent and on demand from the UI. A single snapshot
 * is not useful on its own — the delta between two is what describes a period.
 */
app.post('/api/workload/snapshot', async (_req, res) => {
  try {
    const availability = await probeWorkload(db);
    if (!availability.installed) {
      throw new AgentError(availability.reason ?? 'pg_stat_statements unavailable.', availability.hint, 412);
    }
    const entries = await collectWorkload(db);
    const snapshot = store.recordWorkloadSnapshot(entries);
    res.json({ ...snapshot, entries: entries.length });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * The workload, ranked by total time over the most recent window.
 *
 * Ranked by total, never mean: the query taking 4ms that runs two million
 * times a day costs more than the eight-second report, and only one of those
 * shows up in a slow-query log.
 */
app.get('/api/workload', async (_req, res) => {
  try {
    const availability = await probeWorkload(db);
    if (!availability.installed) {
      res.json({ availability, window: null });
      return;
    }

    const snapshots = store.recentWorkloadSnapshots(2);
    const current = snapshots[0];

    // Nothing recorded yet: take one now so the first visit shows something,
    // clearly labelled as cumulative rather than a window.
    if (!current) {
      const entries = await collectWorkload(db);
      store.recordWorkloadSnapshot(entries);
      const { ranked, totalMs } = rankWorkload(entries);
      res.json({
        availability,
        window: {
          isDelta: false,
          fromAt: null,
          toAt: new Date().toISOString(),
          resetDetected: false,
          totalMs,
          entries: ranked.map(withExplainable),
        },
        snapshots: store.workloadSnapshotCount(),
      });
      return;
    }

    const previous = snapshots[1];
    const { entries, resetDetected } = deltaWorkload(
      (previous?.entries as WorkloadEntry[] | undefined) ?? null,
      current.entries as WorkloadEntry[],
    );
    const { ranked, totalMs } = rankWorkload(entries);

    res.json({
      availability,
      window: {
        isDelta: Boolean(previous),
        fromAt: previous?.takenAt ?? null,
        toAt: current.takenAt,
        resetDetected,
        totalMs,
        entries: ranked.map(withExplainable),
      },
      snapshots: store.workloadSnapshotCount(),
    });
  } catch (err) {
    fail(res, err);
  }
});

/** Attach whether the normalised text can be planned as-is (§6.1). */
function withExplainable<T extends { query: string }>(entry: T) {
  const { ok, reason } = isExplainable(entry.query);
  return { ...entry, explainable: ok, notExplainableReason: reason };
}

// ── Indexes ──────────────────────────────────────────────────────────────────

/**
 * Every user index with its usage evidence, semantics-enforcing ones flagged.
 *
 * Works without hypopg — it reads statistics and the catalog only. The listing
 * never says "safe"; verdicts are the prove endpoint's job.
 */
app.get('/api/indexes', async (_req, res) => {
  try {
    res.json(await listIndexInventory(db));
  } catch (err) {
    fail(res, err);
  }
});

/**
 * Prove an index is safe to drop: hide it with hypopg_hide_index in one
 * session, re-plan every query this agent knows about, diff each plan, and
 * conclude — or refuse, when the index enforces semantics rather than speed.
 */
app.post('/api/whatif/drop-index', async (req, res) => {
  try {
    const index = req.body?.index;
    if (typeof index !== 'string' || index.trim().length === 0) {
      throw new AgentError('Provide an "index" name.');
    }
    const schema = req.body?.schema;
    if (schema !== undefined && schema !== null && typeof schema !== 'string') {
      throw new AgentError('"schema" must be a string or null.');
    }
    res.json(await proveDropIndex(db, store, index, typeof schema === 'string' ? schema : null));
  } catch (err) {
    fail(res, err);
  }
});

app.get('/api/saved', (_req, res) => {
  res.json({ queries: store.listSavedQueries() });
});

app.post('/api/saved', (req, res) => {
  try {
    const sql = requireSql(req.body);
    const name = req.body?.name;
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new AgentError('Provide a "name" for the saved query.');
    }
    if (name.length > 120) throw new AgentError('Name is too long (max 120 characters).');
    res.json(store.saveQuery(name.trim(), sql, fingerprint(sql)));
  } catch (err) {
    fail(res, err);
  }
});

app.delete('/api/saved/:name', (req, res) => {
  const existed = store.deleteSavedQuery(req.params.name);
  if (!existed) {
    res.status(404).json({ error: 'No saved query with that name.', hint: null });
    return;
  }
  res.json({ deleted: true });
});

/**
 * Record what a what-if concluded.
 *
 * The reasoning behind an index is normally lost the moment the person who
 * tested it moves on. This keeps the DDL, the verdict, the numbers, and whether
 * it was ever actually shipped.
 */
app.post('/api/decisions', (req, res) => {
  try {
    const body = req.body ?? {};
    const kinds = ['index', 'settings', 'rewrite', 'drop-index', 'statistics'];
    if (!kinds.includes(body.kind)) {
      throw new AgentError(`kind must be one of ${kinds.map((k) => `"${k}"`).join(', ')}.`);
    }
    if (typeof body.change !== 'string' || body.change.trim().length === 0) {
      throw new AgentError('Provide the "change" that was tested.');
    }
    if (typeof body.verdict !== 'string' || typeof body.fingerprint !== 'string') {
      throw new AgentError('Provide "verdict" and "fingerprint".');
    }
    res.json(
      store.recordDecision({
        analysisSlug: typeof body.analysisSlug === 'string' ? body.analysisSlug : null,
        fingerprint: body.fingerprint,
        kind: body.kind,
        change: body.change,
        verdict: body.verdict,
        headline: typeof body.headline === 'string' ? body.headline : '',
        costBefore: typeof body.costBefore === 'number' ? body.costBefore : null,
        costAfter: typeof body.costAfter === 'number' ? body.costAfter : null,
        costOnly: body.costOnly === true,
      }),
    );
  } catch (err) {
    fail(res, err);
  }
});

app.get('/api/decisions', (req, res) => {
  const fp = req.query['fingerprint'];
  res.json({ decisions: store.listDecisions(typeof fp === 'string' ? fp : undefined) });
});

app.patch('/api/decisions/:id', (req, res) => {
  const updated = store.markDecisionApplied(Number(req.params.id), req.body?.applied === true);
  if (!updated) {
    res.status(404).json({ error: 'No decision with that id.', hint: null });
    return;
  }
  res.json(updated);
});

/** Test a hypothetical index. */
app.post('/api/whatif/index', async (req, res) => {
  try {
    const sql = requireSql(req.body);
    const ddl = req.body?.ddl;
    if (typeof ddl !== 'string' || ddl.trim().length === 0) {
      throw new AgentError('Provide a "ddl" string containing a CREATE INDEX statement.');
    }
    res.json(await whatIfIndex(db, sql, ddl));
  } catch (err) {
    fail(res, err);
  }
});

/**
 * Prove a generated rewrite.
 *
 * The client sends the finding's coordinates, never candidate SQL — the
 * candidate is re-derived from the submitted statement server-side, so a proof
 * can only describe this agent's own transform. Anything else in the body is
 * ignored on purpose.
 */
app.post('/api/whatif/rewrite', async (req, res) => {
  try {
    const sql = requireSql(req.body);
    const kind = req.body?.kind;
    const provable = ['not-in-subquery', 'not-in-list', 'function-on-column',
                      'or-across-columns', 'correlated-subquery-in-select'] as const;
    if (!provable.includes(kind)) {
      throw new AgentError(`kind must be one of ${provable.map((k) => `"${k}"`).join(', ')}.`);
    }
    const location = req.body?.location ?? null;
    if (location !== null && typeof location !== 'number') {
      throw new AgentError('Provide the finding\'s numeric "location", or null.');
    }
    res.json(await whatIfRewrite(db, sql, kind, location, { analyze: req.body?.analyze === true }));
  } catch (err) {
    fail(res, err);
  }
});

/**
 * Prove a CREATE STATISTICS suggestion on the opt-in sandbox.
 *
 * Coordinates only — {sql, relation, columns} — never DDL: every statement
 * that reaches the sandbox is composed server-side from validated parts, and
 * the candidate is re-derived from the SQL's AST (mismatch → 409). Without a
 * configured sandbox this is a 412 that explains QUERYNOT_SANDBOX_URL and the
 * manual recipe; the suggestion stands as advice either way.
 */
app.post('/api/whatif/statistics', async (req, res) => {
  try {
    const sql = requireSql(req.body);
    if (!parserReady) {
      throw new AgentError(
        'The SQL parser failed to load; statistics proofs are unavailable.',
        null,
        503,
      );
    }
    const relation = req.body?.relation;
    if (typeof relation !== 'string' || relation.trim().length === 0) {
      throw new AgentError('Provide the "relation" the statistics object would cover.');
    }
    const columns = req.body?.columns;
    res.json(await whatIfStatistics(sandbox, sql, relation.trim(), columns));
  } catch (err) {
    fail(res, err);
  }
});

/** Re-plan under different settings. */
app.post('/api/whatif/settings', async (req, res) => {
  try {
    const sql = requireSql(req.body);
    const settings = req.body?.settings;
    if (!settings || typeof settings !== 'object') {
      throw new AgentError('Provide a "settings" object, e.g. { "work_mem": "64MB" }.');
    }
    res.json(
      await whatIfSettings(db, sql, settings as Record<string, string>, {
        analyze: req.body?.analyze === true,
      }),
    );
  } catch (err) {
    fail(res, err);
  }
});

/**
 * Analyse, then prove. Every index suggestion is tested against a hypothetical
 * index and the ones that do not change the plan are reported as unproven,
 * rather than presented as advice.
 */
app.post('/api/analyze/verified', async (req, res) => {
  try {
    const sql = requireSql(req.body);
    const analysis = await analyzeQuery(db, sql, { analyze: req.body?.analyze === true });
    const verified = await verifySuggestions(db, sql, analysis.indexSuggestions);

    res.json({
      ...analysis,
      verifiedSuggestions: verified.map(({ suggestion, result, error }) => ({
        suggestion,
        error,
        verdict: result?.diff.summary.verdict ?? null,
        headline: result?.diff.summary.headline ?? null,
        costBefore: result?.diff.summary.costBefore ?? null,
        costAfter: result?.diff.summary.costAfter ?? null,
        costChange: result?.diff.summary.costChange ?? null,
        accessChanges: result?.diff.summary.accessChanges ?? [],
        // The honest bit: an index the planner declines to use is not advice.
        proven: result ? result.diff.summary.verdict === 'improved' : false,
      })),
    });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * Serve the built UI from the agent, so production is one process.
 *
 * Registered after every /api route so it can never shadow one, and it falls
 * through to index.html for unknown paths because the router is client-side —
 * without that, refreshing /reference would 404.
 */
const webDist = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
const servingUi = existsSync(join(webDist, 'index.html'));

if (servingUi) {
  app.use(express.static(webDist, { index: false, maxAge: '1h' }));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(join(webDist, 'index.html'));
  });
}

await initParser()
  .then(() => {
    parserReady = true;
  })
  .catch((err: unknown) => {
    console.warn('[agent] SQL parser unavailable, rewrite advice disabled:', err);
  });

const port = Number(process.env['QUERYNOT_PORT'] ?? 5174);
const server = app.listen(port, () => {
  console.log(`[agent] listening on http://localhost:${port}`);
  console.log(`[agent] statement_timeout ${config.statementTimeoutMs}ms, max ${config.maxConnections} connections`);
  console.log(
    servingUi
      ? `[agent] serving the UI from ${webDist}`
      : '[agent] API only — run `npm run build --workspace @query-not/web` to serve the UI from here too',
  );
  db.probe().then((p) => {
    if (!p.connected) {
      console.warn(`[agent] not connected: ${p.error}`);
      return;
    }
    console.log(`[agent] connected to ${p.database}`);
    if (!p.readOnlyRole) {
      console.warn('[agent] this role can write. Use a read-only role — the transaction guard is a backstop, not the plan.');
    }
    if (!p.hypopgInstalled) {
      console.warn('[agent] hypopg not installed: index what-ifs are unavailable until you CREATE EXTENSION hypopg.');
    }
  });
  if (sandbox) {
    sandbox.probe().then((p) => {
      if (!p.connected) {
        console.warn(`[agent] statistics sandbox not connected: ${p.error}`);
      } else if (p.readOnlyRole) {
        console.warn(
          '[agent] statistics sandbox is configured but its role cannot run DDL — proofs will fail until it owns the target tables.',
        );
      } else {
        console.log(`[agent] statistics sandbox: ${p.database} (proofs run there, in rolled-back transactions)`);
      }
    });
  }
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[agent] ${signal} — shutting down`);
  server.close();
  store.close();
  await db.close();
  await sandbox?.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

export { app, db };
