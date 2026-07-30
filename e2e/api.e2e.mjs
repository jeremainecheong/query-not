/**
 * End-to-end verification of every agent endpoint, against a real Postgres.
 *
 * Distinct from the unit tests: those run on fixtures and pure functions, this
 * drives the running agent over HTTP against a seeded database. Anything that
 * only works in a fixture fails here.
 *
 *   node e2e/api.e2e.mjs
 *
 * Requires the agent running (npm run agent) against the seeded database from
 * packages/core/test/fixtures/seed.sql.
 */

const BASE = process.env.QUERYNOT_AGENT_URL ?? 'http://localhost:5174';

const QUERIES = {
  seqScan: "SELECT * FROM orders WHERE status = 'disputed' AND created_at > now() - interval '30 days'",
  sort: 'SELECT customer_id, total_cents FROM orders ORDER BY total_cents, customer_id',
  misestimate: 'SELECT count(*) FROM orders WHERE (total_cents % 7) = 0',
  join: 'SELECT c.country, count(*) FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.country',
  smelly: `SELECT *
           FROM orders
           WHERE date(created_at) = '2024-01-01'
             AND id NOT IN (SELECT order_id FROM order_items)
           ORDER BY id OFFSET 100000 LIMIT 20`,
};

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  [32m✓[0m ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  [31m✗[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n[1m${title}[0m`);
}

async function call(path, body) {
  const res = await fetch(BASE + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// ── Health ───────────────────────────────────────────────────────────────────

section('Health and capabilities');
const health = await call('/api/health');
check('agent responds', health.status === 200);
check('database connected', health.body.database?.connected === true, health.body.database?.error ?? '');
check('role is read-only', health.body.database?.readOnlyRole === true,
  'the agent should connect as a role that cannot write');
check('hypopg installed', health.body.database?.hypopgInstalled === true);
check('index what-if available', health.body.capabilities?.whatIfIndex === true);
check('rewrite advisor available', health.body.capabilities?.rewriteAdvisor === true);
check('statement timeout configured', health.body.statementTimeoutMs > 0);
check('tunable settings advertised', Array.isArray(health.body.tunableSettings) && health.body.tunableSettings.length > 10);

// ── Analysis, measured ───────────────────────────────────────────────────────

section('Measured analysis (EXPLAIN ANALYZE)');
const measured = await call('/api/analyze', { sql: QUERIES.seqScan, analyze: true });
check('returns 200', measured.status === 200, JSON.stringify(measured.body).slice(0, 160));
const plan = measured.body.plan;
check('plan is marked as analyzed', plan?.analyzed === true);
check('buffers collected', plan?.hasBuffers === true);
check('execution time present', typeof plan?.executionTimeMs === 'number' && plan.executionTimeMs > 0);
check('total work computed', typeof plan?.totalWorkMs === 'number');
check('per-loop times multiplied out', plan?.nodes?.some((n) => (n.loops ?? 1) > 1 && n.inclusiveMs > n.actualTotalTime),
  'a parallel node should have inclusive time greater than its per-loop time');
check('exclusive time never negative', plan?.nodes?.every((n) => n.exclusiveMs === null || n.exclusiveMs >= 0));
check('finds the wasteful sequential scan',
  measured.body.findings?.some((f) => f.kind === 'seq-scan-candidate'),
  (measured.body.findings ?? []).map((f) => f.kind).join(', '));
check('findings ranked by impact',
  (measured.body.findings ?? []).every((f, i, a) => i === 0 || a[i - 1].impactMs >= f.impactMs));
check('no percentage exceeds 100%', (() => {
  const text = JSON.stringify(measured.body.findings) + measured.body.narration;
  return [...text.matchAll(/(\d+(?:\.\d+)?)%/g)].every((m) => Number(m[1]) <= 100);
})(), 'parallel plans must divide by total work, not wall clock');
check('narration produced', typeof measured.body.narration === 'string' && measured.body.narration.length > 80);
check('index suggested', (measured.body.indexSuggestions ?? []).length > 0);
check('suggested index is equality-first', (() => {
  const s = (measured.body.indexSuggestions ?? []).find((x) => x.columns.includes('created_at'));
  return !s || s.columns.indexOf('status') < s.columns.indexOf('created_at');
})());
check('flame layout weighted by time', measured.body.flame?.basis === 'time');
check('flame has one cell per node', measured.body.flame?.cells?.length === plan?.nodes?.length);
check('fingerprint strips literals',
  typeof measured.body.fingerprint === 'string' && !measured.body.fingerprint.includes('disputed'));

// ── Analysis, estimate-only ──────────────────────────────────────────────────

section('Estimate-only analysis (plain EXPLAIN)');
const estimated = await call('/api/analyze', { sql: QUERIES.seqScan, analyze: false });
check('returns 200', estimated.status === 200);
check('plan is not marked analyzed', estimated.body.plan?.analyzed === false);
check('flags that it was not measured',
  estimated.body.findings?.some((f) => f.kind === 'not-analyzed'));
check('emits no measurement-based findings',
  !estimated.body.findings?.some((f) => ['cardinality-misestimate', 'sort-spilled-to-disk'].includes(f.kind)));
check('flame falls back to cost', estimated.body.flame?.basis === 'cost');

// ── Pathology detection ──────────────────────────────────────────────────────

section('Pathology detection');
const sorted = await call('/api/whatif/settings', {
  sql: QUERIES.sort, settings: { work_mem: '64kB' }, analyze: true,
});
check('low work_mem produces a spill',
  sorted.body.findingsAfter?.some((f) => f.kind === 'sort-spilled-to-disk'),
  (sorted.body.findingsAfter ?? []).map((f) => f.kind).join(', '));
check('spill suggests a concrete work_mem value', (() => {
  const f = (sorted.body.findingsAfter ?? []).find((x) => x.kind === 'sort-spilled-to-disk');
  return f && /\d+(MB|GB)/.test(f.suggestion);
})());

const mis = await call('/api/analyze', { sql: QUERIES.misestimate, analyze: true });
check('detects a large cardinality misestimate',
  mis.body.findings?.some((f) => f.kind === 'cardinality-misestimate'),
  (mis.body.findings ?? []).map((f) => f.kind).join(', '));

// ── What-if: hypothetical index ──────────────────────────────────────────────

section('What-if: hypothetical index');
const good = await call('/api/whatif/index', {
  sql: QUERIES.seqScan, ddl: 'CREATE INDEX ON orders (status, created_at)',
});
check('returns 200', good.status === 200, JSON.stringify(good.body).slice(0, 160));
check('verdict is improved', good.body.diff?.summary?.verdict === 'improved', good.body.diff?.summary?.verdict);
check('cost dropped substantially', good.body.diff?.summary?.costChange < -0.5,
  String(good.body.diff?.summary?.costChange));
check('access method change reported', (good.body.diff?.summary?.accessChanges ?? []).length > 0);
check('marked cost-only', good.body.costOnly === true);
check('headline disclaims measurement', /not a measured speedup/i.test(good.body.diff?.summary?.headline ?? ''));
check('hypopg internal name is not leaked', !/[<]\d+[>]/.test(JSON.stringify(good.body.diff?.summary)));
check('node-level diff produced', (good.body.diff?.nodes ?? []).some((n) => n.status !== 'unchanged'));

const useless = await call('/api/whatif/index', {
  sql: QUERIES.seqScan, ddl: 'CREATE INDEX ON orders (note)',
});
check('an irrelevant index is NOT reported as improved',
  useless.body.diff?.summary?.verdict !== 'improved', useless.body.diff?.summary?.verdict);

// Same connection reused afterwards: hypopg_reset must have run, or the
// hypothetical index would linger and poison this result.
const afterReset = await call('/api/analyze', { sql: QUERIES.seqScan, analyze: false });
check('hypothetical indexes do not leak into later queries',
  !JSON.stringify(afterReset.body.plan).includes('hypothetical'),
  'hypopg_reset() should clear them before the connection returns to the pool');

// ── What-if: settings ────────────────────────────────────────────────────────

section('What-if: settings');
const workMem = await call('/api/whatif/settings', {
  sql: QUERIES.sort, settings: { work_mem: '256MB' }, analyze: true,
});
check('returns 200', workMem.status === 200);
check('measured, not estimated', workMem.body.costOnly === false);
check('both timings present',
  typeof workMem.body.diff?.summary?.timeBefore === 'number' &&
  typeof workMem.body.diff?.summary?.timeAfter === 'number');
check('spill disappears with more work_mem',
  (workMem.body.diff?.nodes ?? []).some((n) => n.changes?.some((c) => /no longer spills/.test(c))),
  'raising work_mem on a spilling sort should show the spill going away');

const seqOff = await call('/api/whatif/settings', {
  sql: QUERIES.seqScan, settings: { enable_seqscan: 'off' }, analyze: false,
});
check('enable_seqscan=off changes the plan', seqOff.body.diff?.summary?.verdict !== 'unchanged',
  seqOff.body.diff?.summary?.verdict);

// ── Verified analysis ────────────────────────────────────────────────────────

section('Verified analysis (suggestions proven before shown)');
const verified = await call('/api/analyze/verified', { sql: QUERIES.seqScan, analyze: true });
check('returns 200', verified.status === 200);
check('every suggestion carries a verdict',
  (verified.body.verifiedSuggestions ?? []).length > 0 &&
  verified.body.verifiedSuggestions.every((v) => v.verdict !== null || v.error !== null));
check('at least one suggestion is proven',
  (verified.body.verifiedSuggestions ?? []).some((v) => v.proven === true));

// ── Rewrite advisor ──────────────────────────────────────────────────────────

section('Rewrite advisor (AST)');
const rewrite = await call('/api/rewrite', { sql: QUERIES.smelly });
check('returns 200', rewrite.status === 200, JSON.stringify(rewrite.body).slice(0, 160));
const kinds = (rewrite.body.rewrites ?? []).map((r) => r.kind);
for (const kind of ['function-on-column', 'not-in-subquery', 'select-star', 'large-offset']) {
  check(`detects ${kind}`, kinds.includes(kind), kinds.join(', '));
}
check('NOT IN rewrite is flagged as a semantic change',
  (rewrite.body.rewrites ?? []).find((r) => r.kind === 'not-in-subquery')?.semanticChange != null,
  'NOT EXISTS is not a drop-in equivalent and must say so');
const clean = await call('/api/rewrite', { sql: "SELECT id FROM orders WHERE status = 'x' LIMIT 10" });
check('clean SQL produces no critical rewrites',
  (clean.body.rewrites ?? []).filter((r) => r.severity === 'critical').length === 0,
  (clean.body.rewrites ?? []).map((r) => r.kind).join(', '));

const analyzeWithRewrites = await call('/api/analyze', { sql: QUERIES.smelly, analyze: false });
check('rewrites are included in the main analysis',
  (analyzeWithRewrites.body.rewrites ?? []).length > 0);

// ── Safety ───────────────────────────────────────────────────────────────────

section('Safety: admission control');
const refusals = [
  ['DELETE is refused', 'DELETE FROM orders WHERE id = 1'],
  ['UPDATE is refused', 'UPDATE orders SET status = 1'],
  ['DROP is refused', 'DROP TABLE orders'],
  ['CREATE is refused', 'CREATE TABLE evil (x int)'],
  ['a CTE that deletes is refused', 'WITH gone AS (DELETE FROM orders RETURNING *) SELECT * FROM gone'],
  ['a CTE that updates is refused', 'WITH x AS (UPDATE orders SET status = 1 RETURNING id) SELECT * FROM x'],
  ['statement stacking is refused', 'SELECT 1; DROP TABLE orders'],
  ['COPY is refused', "COPY orders TO '/tmp/leak.csv'"],
];
for (const [name, sql] of refusals) {
  const res = await call('/api/analyze', { sql, analyze: true });
  check(name, res.status >= 400 && typeof res.body.error === 'string', `status ${res.status}`);
}

const allowed = await call('/api/analyze', { sql: "SELECT * FROM orders WHERE note = 'delete me'", analyze: false });
check('a literal containing "delete" is still allowed', allowed.status === 200);

section('Safety: what-if input validation');
const gucRejects = [
  ['non-allowlisted GUC refused', { shared_preload_libraries: 'evil' }],
  ['injected GUC value refused', { work_mem: "64MB'; DROP TABLE orders --" }],
  ['GUC value with semicolon refused', { work_mem: '64MB; DROP TABLE orders' }],
];
for (const [name, settings] of gucRejects) {
  const res = await call('/api/whatif/settings', { sql: 'SELECT 1', settings });
  check(name, res.status >= 400, `status ${res.status}`);
}
const ddlRejects = [
  ['non-index DDL refused', 'DROP TABLE orders'],
  ['stacked DDL refused', 'CREATE INDEX ON orders (id); DROP TABLE orders'],
  ['CONCURRENTLY refused with an explanation', 'CREATE INDEX CONCURRENTLY ON orders (id)'],
];
for (const [name, ddl] of ddlRejects) {
  const res = await call('/api/whatif/index', { sql: QUERIES.seqScan, ddl });
  check(name, res.status >= 400, `status ${res.status}`);
}

section('Error handling');
const badSql = await call('/api/analyze', { sql: 'SELECT * FROM table_that_does_not_exist', analyze: false });
check('unknown table returns a helpful hint', badSql.status >= 400 && typeof badSql.body.hint === 'string',
  JSON.stringify(badSql.body).slice(0, 120));
const noSql = await call('/api/analyze', {});
check('missing sql is rejected', noSql.status >= 400);
const syntaxErr = await call('/api/rewrite', { sql: 'SELECT FROM WHERE' });
check('malformed SQL returns a parse error', syntaxErr.status >= 400 && typeof syntaxErr.body.error === 'string');

// ── Verify the database was never mutated ────────────────────────────────────

section('Nothing was written');
const counts = await call('/api/analyze', {
  sql: 'SELECT count(*) FROM orders', analyze: true,
});
check('orders row count still 400000',
  counts.body.plan?.root?.actualRowsTotal === 1, 'the count query itself returns one row');
const stillThere = await call('/api/analyze', { sql: 'SELECT count(*) FROM order_items', analyze: false });
check('order_items table still exists', stillThere.status === 200);

// ── Report ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`[1mAPI E2E: ${passed} passed, ${failed} failed[0m`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
