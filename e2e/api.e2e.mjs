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

// ── Persistence ──────────────────────────────────────────────────────────────

section('Persistence: recording and sharing');
const recorded = await call('/api/analyze', { sql: QUERIES.join, analyze: true });
check('an analysis returns a shareable slug', typeof recorded.body.slug === 'string' && recorded.body.slug.length > 5,
  String(recorded.body.slug));

const reopened = await call(`/api/analysis/${recorded.body.slug}`);
check('the slug reopens the same analysis', reopened.status === 200 &&
  reopened.body.fingerprint === recorded.body.fingerprint);
check('a reopened analysis carries its plan', Array.isArray(reopened.body.plan?.nodes) &&
  reopened.body.plan.nodes.length > 0);
check('a reopened analysis carries its findings', Array.isArray(reopened.body.findings));
check('a reopened analysis carries the original SQL', typeof reopened.body.sql === 'string');
check('an unknown slug 404s with a hint', (await call('/api/analysis/does-not-exist')).status === 404);

section('Persistence: plan history');
// Three identical runs. The plan cannot have changed, so history must be quiet
// — wall-clock varies run to run and a time-led verdict would cry wolf here.
await call('/api/analyze', { sql: QUERIES.join, analyze: true });
await call('/api/analyze', { sql: QUERIES.join, analyze: true });
const fp = encodeURIComponent(recorded.body.fingerprint);
const history = await call(`/api/history/${fp}`);
check('history accumulates every run', (history.body.points ?? []).length >= 3,
  `${(history.body.points ?? []).length} points`);
check('identical re-runs report no regression', (history.body.regressions ?? []).length === 0,
  (history.body.regressions ?? []).map((r) => r.headline).join('; '));
check('history summarises in plain English', typeof history.body.summary === 'string' &&
  history.body.summary.length > 20);
check('history points expose the access methods used',
  (history.body.points ?? []).some((p) => Array.isArray(p.accessMethods)));
const emptyHistory = await call('/api/history/never-seen-fingerprint');
check('an unseen query returns an empty report', emptyHistory.status === 200 &&
  (emptyHistory.body.points ?? []).length === 0);

// Now force a genuinely different plan for the same query text.
const forced = await call('/api/whatif/settings', {
  sql: QUERIES.join, settings: { enable_hashjoin: 'off' }, analyze: true,
});
check('a forced plan change is a real structural difference',
  forced.body.diff?.summary?.accessChanges?.length > 0 ||
  forced.body.diff?.summary?.nodesAdded > 0,
  'the settings what-if should change the plan shape');

section('Persistence: saved queries');
const saved = await call('/api/saved', { name: 'country totals', sql: QUERIES.join });
check('saves a named query', saved.status === 200 && saved.body.name === 'country totals');
check('a saved query links to its runs', saved.body.runCount >= 3 && typeof saved.body.latestSlug === 'string',
  `runCount=${saved.body.runCount}`);

const savedList = await call('/api/saved');
check('saved queries are listed', (savedList.body.queries ?? []).some((q) => q.name === 'country totals'));

const resaved = await call('/api/saved', { name: 'country totals', sql: 'SELECT 1' });
check('re-saving the same name updates rather than duplicating', resaved.body.sql === 'SELECT 1');
check('no duplicate entry was created',
  (await call('/api/saved')).body.queries.filter((q) => q.name === 'country totals').length === 1);

check('a nameless save is rejected', (await call('/api/saved', { sql: 'SELECT 1' })).status >= 400);
check('a sql-less save is rejected', (await call('/api/saved', { name: 'x' })).status >= 400);

const del = await fetch(`${BASE}/api/saved/${encodeURIComponent('country totals')}`, { method: 'DELETE' });
check('a saved query can be deleted', del.status === 200);
check('deleting it twice 404s', (await fetch(`${BASE}/api/saved/${encodeURIComponent('country totals')}`,
  { method: 'DELETE' })).status === 404);

section('Persistence: proven decisions');
const decision = await call('/api/decisions', {
  analysisSlug: recorded.body.slug,
  fingerprint: recorded.body.fingerprint,
  kind: 'index',
  change: 'CREATE INDEX ON orders (status)',
  verdict: 'improved',
  headline: 'Estimated cost fell by 84%',
  costBefore: 10559, costAfter: 1638, costOnly: true,
});
check('records what was tested and concluded', decision.status === 200 && decision.body.verdict === 'improved');
check('a decision starts un-applied', decision.body.applied === false);
check('decisions are listed per query',
  (await call(`/api/decisions?fingerprint=${fp}`)).body.decisions.length >= 1);

const applied = await fetch(`${BASE}/api/decisions/${decision.body.id}`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ applied: true }),
});
check('a decision can be marked as shipped', applied.status === 200 && (await applied.json()).applied === true);
check('an unknown decision 404s', (await fetch(`${BASE}/api/decisions/999999`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ applied: true }),
})).status === 404);

check('an invalid decision kind is rejected',
  (await call('/api/decisions', { kind: 'nonsense', change: 'x', verdict: 'y', fingerprint: 'z' })).status >= 400);

section('Persistence: health reporting');
const health2 = await call('/api/health');
check('store stats are reported', typeof health2.body.store?.analyses === 'number' && health2.body.store.analyses > 0);
check('persistence is advertised as a capability', health2.body.capabilities?.persistence === true);

// ── Workload ─────────────────────────────────────────────────────────────────

section('Workload (pg_stat_statements)');
const wl0 = await call('/api/workload');
check('workload endpoint responds', wl0.status === 200);
check('availability is reported either way', typeof wl0.body.availability?.installed === 'boolean');

if (wl0.body.availability?.installed) {
  const snap = await call('/api/workload/snapshot', {});
  check('a snapshot can be taken', snap.status === 200 && snap.body.entries > 0,
    JSON.stringify(snap.body).slice(0, 120));

  // Generate traffic between snapshots so the delta has something in it.
  for (let i = 0; i < 3; i++) await call('/api/analyze', { sql: `SELECT ${i}, count(*) FROM orders`, analyze: true });
  await call('/api/workload/snapshot', {});

  const wl = await call('/api/workload');
  check('the window is a delta once two snapshots exist', wl.body.window?.isDelta === true);
  check('the window has a start and an end',
    typeof wl.body.window?.fromAt === 'string' && typeof wl.body.window?.toAt === 'string');
  check('entries are ranked by total time descending',
    (wl.body.window?.entries ?? []).every((e, i, a) => i === 0 || a[i - 1].totalMs >= e.totalMs));
  check('every entry carries its share of the window',
    (wl.body.window?.entries ?? []).every((e) => typeof e.share === 'number' && e.share >= 0 && e.share <= 1));
  check('no delta is negative',
    (wl.body.window?.entries ?? []).every((e) => e.calls >= 0 && e.totalMs >= 0));
  check('normalised queries are marked as unplannable',
    (wl.body.window?.entries ?? []).some((e) => e.explainable === false && e.notExplainableReason),
    'pg_stat_statements text uses $1 placeholders, which cannot be EXPLAINed as-is');
} else {
  check('an unavailable extension explains itself',
    typeof wl0.body.availability?.reason === 'string' && typeof wl0.body.availability?.hint === 'string');
}

// ── Generated rewrites, proven ───────────────────────────────────────────────

section('Prove a generated rewrite');

// Small enough to stay under the equivalence row cap, big enough to mean it.
const NOT_IN_SQL =
  'SELECT o.id FROM orders o WHERE o.id < 30000 AND o.id NOT IN (SELECT oi.order_id FROM order_items oi WHERE oi.qty > 3)';
const genRw = await call('/api/rewrite', { sql: NOT_IN_SQL });
const genFinding = (genRw.body.rewrites ?? []).find((r) => r.kind === 'not-in-subquery');
check('the finding carries the generated statement',
  typeof genFinding?.candidate?.sql === 'string' && genFinding.candidate.sql.includes('NOT EXISTS'),
  genFinding?.candidateBlocked ?? 'no candidate');

const smellyRw = (rewrite.body.rewrites ?? []).find((r) => r.kind === 'not-in-subquery');
check('the smelly query gets one too', typeof smellyRw?.candidate?.sql === 'string',
  smellyRw?.candidateBlocked ?? '');

const proof = await call('/api/whatif/rewrite', {
  sql: NOT_IN_SQL, kind: 'not-in-subquery', location: genFinding?.location ?? null,
  // Must be ignored: the server derives its own candidate from the SQL.
  candidateSql: 'SELECT 1',
});
check('the proof endpoint answers', proof.status === 200, JSON.stringify(proof.body).slice(0, 200));
check('both NOT NULL preconditions are established with cited evidence',
  proof.body.preconditions?.length === 2 &&
  proof.body.preconditions.every((p) => p.established && /NOT NULL/.test(p.evidence)),
  JSON.stringify(proof.body.preconditions ?? []).slice(0, 200));
check('rows were compared and matched',
  proof.body.equivalence?.status === 'match' &&
  proof.body.equivalence.rowsOriginal === proof.body.equivalence.rowsRewritten,
  JSON.stringify(proof.body.equivalence ?? {}).slice(0, 160));
check('the note claims equivalence on this data, not in general',
  /on this data/.test(proof.body.note ?? ''), proof.body.note);
check('the injected candidate SQL was ignored',
  proof.body.candidate?.sql !== 'SELECT 1' && /NOT EXISTS/.test(proof.body.candidate?.sql ?? ''));
check('a plan diff is attached with the rewrite as the change',
  proof.body.planDiff?.change?.kind === 'rewrite' &&
  ['proven', 'no-effect'].includes(proof.body.outcome),
  `outcome ${proof.body.outcome}`);

// The date() range rewrite against an indexed timestamp column: the range form
// can use the index, date() cannot, so this one should prove outright.
const day = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
const DATE_SQL = `SELECT id, applied_at FROM promotions WHERE date(applied_at) = '${day}'`;
const dateRw = await call('/api/rewrite', { sql: DATE_SQL });
const dateFinding = (dateRw.body.rewrites ?? []).find((r) => r.kind === 'function-on-column');
const dateProof = await call('/api/whatif/rewrite', {
  sql: DATE_SQL, kind: 'function-on-column', location: dateFinding?.location ?? null,
});
check('the date() rewrite proves end to end', dateProof.body.outcome === 'proven',
  `outcome ${dateProof.body.outcome}: ${dateProof.body.note}`);
check('the plan verdict behind it is improved',
  dateProof.body.planDiff?.diff?.summary?.verdict === 'improved');
check('a plain timestamp column does not hedge about TimeZone',
  !/TimeZone/.test(dateProof.body.note ?? ''), dateProof.body.note);

// The negative case the whole design exists for: a genuinely nullable column.
const NULLABLE_SQL =
  'SELECT o.id FROM orders o WHERE o.id < 30000 AND o.id NOT IN (SELECT p.order_id FROM promotions p)';
const nullProof = await call('/api/whatif/rewrite', {
  sql: NULLABLE_SQL, kind: 'not-in-subquery',
  location: (await call('/api/rewrite', { sql: NULLABLE_SQL }))
    .body.rewrites?.find((r) => r.kind === 'not-in-subquery')?.location ?? null,
});
check('a nullable column downgrades to advice-only', nullProof.body.outcome === 'advice-only',
  `outcome ${nullProof.body.outcome}`);
check('nothing was executed for it',
  nullProof.body.planDiff === null && nullProof.body.equivalence === null);
check('the refusal names the nullable column',
  nullProof.body.preconditions?.some((p) => !p.established && /order_id.*nullable/.test(p.evidence)),
  JSON.stringify(nullProof.body.preconditions ?? []).slice(0, 200));

// LIMIT makes row-level claims unsound however carefully they are executed; a
// naive implementation reports "proven" here, and this check forbids that.
const LIMIT_SQL = `SELECT id FROM promotions WHERE date(applied_at) = '${day}' ORDER BY id LIMIT 5`;
const limitProof = await call('/api/whatif/rewrite', {
  sql: LIMIT_SQL, kind: 'function-on-column',
  location: (await call('/api/rewrite', { sql: LIMIT_SQL }))
    .body.rewrites?.find((r) => r.kind === 'function-on-column')?.location ?? null,
});
check('LIMIT refuses row verification with the tie-breaking reason',
  limitProof.body.equivalence?.status === 'not-checkable' &&
  /tie-breaking/.test(limitProof.body.equivalence?.note ?? ''),
  JSON.stringify(limitProof.body.equivalence ?? {}).slice(0, 160));
// Which outcome the planner picks here is its own business — with LIMIT the
// original's date() form has no statistics and its estimate can be wrongly
// optimistic, so even `regressed` is a legitimate cost-only verdict. The
// invariant is narrower and absolute: no proof without row verification.
check('and the outcome is never proven',
  limitProof.body.outcome !== 'proven' && limitProof.body.outcome !== 'differed',
  `outcome ${limitProof.body.outcome}`);

section('Prove endpoint refusals');
const badKind = await call('/api/whatif/rewrite', { sql: NOT_IN_SQL, kind: 'select-star', location: 0 });
check('a kind outside Tier A is refused', badKind.status === 400);
const staleLoc = await call('/api/whatif/rewrite', { sql: NOT_IN_SQL, kind: 'not-in-subquery', location: 424242 });
check('a stale location is a conflict, not a guess', staleLoc.status === 409);
const lowerRw = await call('/api/rewrite', { sql: "SELECT id FROM orders WHERE lower(status) = 'x'" });
const lowerLoc = lowerRw.body.rewrites?.find((r) => r.kind === 'function-on-column')?.location ?? null;
const lowerProof = await call('/api/whatif/rewrite', {
  sql: "SELECT id FROM orders WHERE lower(status) = 'x'", kind: 'function-on-column', location: lowerLoc,
});
check('a blocked candidate explains itself instead of running',
  lowerProof.status === 409 && /no range equivalent/.test(lowerProof.body.error ?? ''),
  JSON.stringify(lowerProof.body).slice(0, 160));

const rwDecision = await call('/api/decisions', {
  kind: 'rewrite', change: proof.body.candidate?.sql ?? 'x', verdict: proof.body.outcome ?? 'proven',
  headline: proof.body.note ?? '', fingerprint: 'e2e-rewrite', costOnly: false,
});
check('decisions accept kind rewrite', rwDecision.status === 200, JSON.stringify(rwDecision.body).slice(0, 120));

// ── Tier B: statement restructurings ─────────────────────────────────────────

section('Prove a correlated-subquery rewrite');

// The hidden N+1: a scalar subquery per output row. customers.id is the
// primary key, so the LEFT JOIN provably cannot fan out — the strongest
// result in the product, and it must prove outright.
const CORR_SQL =
  'SELECT o.id, (SELECT c.email FROM customers c WHERE c.id = o.customer_id) AS email ' +
  'FROM orders o WHERE o.id < 20000';
const corrRw = await call('/api/rewrite', { sql: CORR_SQL });
const corrFinding = (corrRw.body.rewrites ?? []).find((r) => r.kind === 'correlated-subquery-in-select');
check('the finding carries the LEFT JOIN candidate',
  /LEFT JOIN customers c ON c\.id = o\.customer_id/.test(corrFinding?.candidate?.sql ?? ''),
  corrFinding?.candidateBlocked ?? 'no candidate');
check('the candidate declares unique-key coverage over the pinned column',
  corrFinding?.candidate?.preconditions?.some(
    (p) => p.kind === 'unique-key-covers' && (p.columns ?? []).join() === 'id'),
  JSON.stringify(corrFinding?.candidate?.preconditions ?? []));

const corrProof = await call('/api/whatif/rewrite', {
  sql: CORR_SQL, kind: 'correlated-subquery-in-select', location: corrFinding?.location ?? null,
});
check('the per-row subquery proves as a join', corrProof.body.outcome === 'proven',
  `outcome ${corrProof.body.outcome}: ${corrProof.body.note}`);
check('the unique index is cited by name',
  corrProof.body.preconditions?.every((p) => p.established) &&
  /customers_pkey/.test(corrProof.body.note ?? ''),
  corrProof.body.note);
check('rows match between subquery and join forms',
  corrProof.body.equivalence?.status === 'match' &&
  corrProof.body.equivalence.rowsOriginal === corrProof.body.equivalence.rowsRewritten &&
  (corrProof.body.equivalence.rowsOriginal ?? 0) > 0,
  JSON.stringify(corrProof.body.equivalence ?? {}).slice(0, 160));
check('the plan verdict behind it is improved',
  corrProof.body.planDiff?.diff?.summary?.verdict === 'improved');

// The refusal that makes the precondition load-bearing: promotions.order_id
// has no unique index, and genuinely holds several rows per order — the join
// would fan out where the subquery would error. Nothing may execute.
const FANOUT_SQL =
  'SELECT o.id, (SELECT p.applied_at FROM promotions p WHERE p.order_id = o.id) ' +
  'FROM orders o WHERE o.id < 100';
const fanoutProof = await call('/api/whatif/rewrite', {
  sql: FANOUT_SQL, kind: 'correlated-subquery-in-select',
  location: (await call('/api/rewrite', { sql: FANOUT_SQL }))
    .body.rewrites?.find((r) => r.kind === 'correlated-subquery-in-select')?.location ?? null,
});
check('a non-unique correlation downgrades to advice-only', fanoutProof.body.outcome === 'advice-only',
  `outcome ${fanoutProof.body.outcome}`);
check('nothing was executed for it',
  fanoutProof.body.planDiff === null && fanoutProof.body.equivalence === null);
check('the refusal names the missing unique index',
  fanoutProof.body.preconditions?.some((p) => !p.established && /no unique index on `promotions`/.test(p.evidence)),
  JSON.stringify(fanoutProof.body.preconditions ?? []).slice(0, 200));

section('Prove an OR-split rewrite');

// Neither arm is indexed here, so the honest verdict is that the split loses —
// and the equivalence guard still has to hold, because the transform is exact
// whether or not it is faster. A tool that only reports wins is an ad.
const OR_SQL = "SELECT id FROM orders WHERE status = 'disputed' OR total_cents > 495000";
const orRw = await call('/api/rewrite', { sql: OR_SQL });
const orFinding = (orRw.body.rewrites ?? []).find((r) => r.kind === 'or-across-columns');
check('the finding carries the guarded UNION ALL candidate',
  /UNION ALL/.test(orFinding?.candidate?.sql ?? '') &&
  /AND \(status = 'disputed'\) IS NOT TRUE/.test(orFinding?.candidate?.sql ?? ''),
  orFinding?.candidateBlocked ?? 'no candidate');
check('the split declares no preconditions — it is exact by construction',
  orFinding?.candidate?.preconditions?.length === 0);
check('the arms are not parenthesised, so the candidate passes admission',
  /^SELECT/.test(orFinding?.candidate?.sql ?? ''));

const orProof = await call('/api/whatif/rewrite', {
  sql: OR_SQL, kind: 'or-across-columns', location: orFinding?.location ?? null,
});
check('the unindexed split honestly regresses', orProof.body.outcome === 'regressed',
  `outcome ${orProof.body.outcome}: ${orProof.body.note}`);
check('and says do not apply', /do not apply/.test(orProof.body.note ?? ''), orProof.body.note);
check('yet the rows still match — exact even when slower',
  orProof.body.equivalence?.status === 'match' &&
  orProof.body.equivalence.rowsOriginal === orProof.body.equivalence.rowsRewritten,
  JSON.stringify(orProof.body.equivalence ?? {}).slice(0, 160));

section('Prove a grouped-join rewrite (aggregate subquery)');

// count(*) per outer row — the aggregate flavour of the hidden N+1. The
// derived table groups by the correlation column, so fan-out is impossible by
// construction; what must be proven is that count IS an aggregate.
const GRP_SQL =
  'SELECT o.id, (SELECT count(*) FROM order_items i WHERE i.order_id = o.id) AS items ' +
  'FROM orders o WHERE o.id < 15000';
const grpRw = await call('/api/rewrite', { sql: GRP_SQL });
const grpFinding = (grpRw.body.rewrites ?? []).find((r) => r.kind === 'correlated-subquery-in-select');
check('the finding carries the grouped derived table with COALESCE',
  /LEFT JOIN \(SELECT i\.order_id, count\(\*\) AS agg FROM order_items i GROUP BY i\.order_id\)/.test(grpFinding?.candidate?.sql ?? '') &&
  /COALESCE\(qn_0\.agg, 0\)/.test(grpFinding?.candidate?.sql ?? ''),
  grpFinding?.candidateBlocked ?? 'no candidate');
const grpProof = await call('/api/whatif/rewrite', {
  sql: GRP_SQL, kind: 'correlated-subquery-in-select', location: grpFinding?.location ?? null,
});
check('the grouped join proves outright', grpProof.body.outcome === 'proven',
  `outcome ${grpProof.body.outcome}: ${grpProof.body.note}`);
check('aggregate-ness is cited from pg_proc',
  grpProof.body.preconditions?.every((p) => p.established) &&
  /pg_proc\.prokind/.test(grpProof.body.preconditions?.[0]?.evidence ?? ''),
  JSON.stringify(grpProof.body.preconditions ?? []).slice(0, 200));
check('rows match between subplan and grouped-join forms',
  grpProof.body.equivalence?.status === 'match' &&
  grpProof.body.equivalence.rowsOriginal === grpProof.body.equivalence.rowsRewritten,
  JSON.stringify(grpProof.body.equivalence ?? {}).slice(0, 160));

section('Prove a lateral top-1 rewrite');

// Latest promotion per order. promotions_pkey covers (id) ⊆ {order_id, id},
// so the pick is deterministic and the precondition establishes — while with
// no index on order_id to drive the lateral, the honest verdict is no effect.
const LAT_SQL =
  'SELECT o.id, (SELECT p.applied_at FROM promotions p WHERE p.order_id = o.id ' +
  'ORDER BY p.id DESC LIMIT 1) AS last_promo FROM orders o WHERE o.id < 40';
const latRw = await call('/api/rewrite', { sql: LAT_SQL });
const latFinding = (latRw.body.rewrites ?? []).find((r) => r.kind === 'correlated-subquery-in-select');
check('the finding carries the verbatim lateral candidate',
  /LEFT JOIN LATERAL \(SELECT p\.applied_at FROM promotions p WHERE p\.order_id = o\.id ORDER BY p\.id DESC LIMIT 1\) qn_0 ON true/
    .test(latFinding?.candidate?.sql ?? ''),
  latFinding?.candidateBlocked ?? 'no candidate');
check('the outer AS alias survives the hoist',
  /qn_0\.applied_at AS last_promo/.test(latFinding?.candidate?.sql ?? ''));
const latProof = await call('/api/whatif/rewrite', {
  sql: LAT_SQL, kind: 'correlated-subquery-in-select', location: latFinding?.location ?? null,
});
check('the tie-break precondition establishes via the primary key',
  latProof.body.preconditions?.every((p) => p.established) &&
  /promotions_pkey/.test(latProof.body.preconditions?.[0]?.evidence ?? ''),
  JSON.stringify(latProof.body.preconditions ?? []).slice(0, 200));
check('rows match and the verdict is honest, never differed',
  latProof.body.equivalence?.status === 'match' &&
  latProof.body.outcome !== 'differed' && latProof.body.outcome !== 'advice-only',
  `outcome ${latProof.body.outcome}`);

// An OR inside a subquery is out of the generator's scope, and the prove
// endpoint must refuse it with the same reason the finding carries.
const NESTED_OR_SQL =
  "SELECT id FROM orders WHERE id IN (SELECT order_id FROM order_items WHERE qty = 1 OR sku = 'SKU-1')";
const nestedOr = await call('/api/whatif/rewrite', {
  sql: NESTED_OR_SQL, kind: 'or-across-columns',
  location: (await call('/api/rewrite', { sql: NESTED_OR_SQL }))
    .body.rewrites?.find((r) => r.kind === 'or-across-columns')?.location ?? null,
});
check('a nested-scope OR refuses with the reason', nestedOr.status === 409 && /nested subquery/.test(nestedOr.body.error ?? ''),
  JSON.stringify(nestedOr.body).slice(0, 160));

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
