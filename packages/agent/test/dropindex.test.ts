import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  assembleProofSet,
  buildIndexInventoryProbe,
  buildIndexResolveProbe,
  composeDropNote,
  disqualifiersFor,
  dropVerdict,
  interpretIndexInventory,
  MAX_PROOF_QUERIES,
  usageEvidence,
  type IndexInventoryRow,
  type PerQueryDropResult,
} from '../src/dropindex.ts';

const row = (over: Partial<IndexInventoryRow>): IndexInventoryRow => ({
  schema: 'public',
  table: 'orders',
  index: 'orders_note_idx',
  scans: 0,
  last_scan_at: null,
  size_bytes: 8192,
  definition: 'CREATE INDEX orders_note_idx ON public.orders USING btree (note)',
  is_unique: false,
  is_primary: false,
  is_valid: true,
  is_replident: false,
  constraint_names: null,
  constraint_types: null,
  ...over,
});

const CTX = { statsResetAt: '2026-06-01T00:00:00.000Z', hasLastScan: true };

const perQuery = (over: Partial<PerQueryDropResult>): PerQueryDropResult => ({
  fingerprint: 'select ?',
  sql: 'SELECT 1',
  source: 'store',
  usedIndex: false,
  verdict: 'unchanged',
  headline: 'No change.',
  costBefore: 10,
  costAfter: 10,
  costChange: 0,
  accessChanges: [],
  error: null,
  ...over,
});

// ── Probes ───────────────────────────────────────────────────────────────────

describe('probe construction', () => {
  test('inventory probe orders scans ASC then size DESC, one row per index', () => {
    const probe = buildIndexInventoryProbe(true);
    assert.match(probe.text, /pg_stat_user_indexes/);
    assert.match(probe.text, /s\.last_idx_scan/);
    assert.match(probe.text, /LEFT JOIN LATERAL/);
    assert.match(probe.text, /ORDER BY s\.idx_scan ASC, pg_relation_size\(s\.indexrelid\) DESC/);
  });

  test('without last_idx_scan the column degrades to NULL, never errors', () => {
    const probe = buildIndexInventoryProbe(false);
    assert.match(probe.text, /NULL::timestamptz AS last_scan_at/);
    assert.doesNotMatch(probe.text, /last_idx_scan/);
  });

  test('the resolve probe binds the name to to_regclass, never interpolates', () => {
    const probe = buildIndexResolveProbe(true);
    assert.match(probe.text, /to_regclass\(\$1\)/);
    assert.match(probe.text, /c\.oid::bigint AS index_oid/);
  });
});

// ── Disqualifiers ────────────────────────────────────────────────────────────

describe('interpretIndexInventory: disqualifiers', () => {
  test('a primary key is not droppable and cites pg_index.indisprimary', () => {
    const [entry] = interpretIndexInventory(
      [row({ index: 'orders_pkey', is_unique: true, is_primary: true, constraint_names: ['orders_pkey'], constraint_types: ['p'] })],
      CTX,
    );
    assert.equal(entry.droppableForPerformance, false);
    assert.equal(entry.disqualifiers[0].kind, 'primary-key');
    assert.match(entry.disqualifiers[0].evidence, /`orders_pkey`/);
    assert.match(entry.disqualifiers[0].evidence, /pg_index\.indisprimary/);
    // The 'p' constraint row must not double-report what indisprimary said.
    assert.equal(entry.disqualifiers.length, 1);
  });

  test('unique non-primary cites pg_index.indisunique', () => {
    const [entry] = interpretIndexInventory([row({ index: 'orders_email_key', is_unique: true })], CTX);
    assert.equal(entry.droppableForPerformance, false);
    assert.equal(entry.disqualifiers[0].kind, 'unique');
    assert.match(entry.disqualifiers[0].evidence, /pg_index\.indisunique/);
  });

  test("an exclusion constraint cites pg_constraint.contype = 'x'", () => {
    const [entry] = interpretIndexInventory(
      [row({ index: 'rooms_excl', constraint_names: ['no_overlap'], constraint_types: ['x'] })],
      CTX,
    );
    assert.equal(entry.disqualifiers[0].kind, 'exclusion-constraint');
    assert.match(entry.disqualifiers[0].evidence, /`no_overlap`/);
    assert.match(entry.disqualifiers[0].evidence, /pg_constraint\.contype = 'x'/);
  });

  test('a replica identity index is a disqualifier, like a primary key', () => {
    const [entry] = interpretIndexInventory([row({ index: 'orders_rid', is_replident: true })], CTX);
    assert.equal(entry.droppableForPerformance, false);
    assert.equal(entry.disqualifiers[0].kind, 'replica-identity');
    assert.match(entry.disqualifiers[0].evidence, /pg_index\.indisreplident/);
    assert.match(entry.disqualifiers[0].evidence, /replication/);
  });

  test('an FK-referenced unique index names the depending constraint', () => {
    const disq = disqualifiersFor('orders_id_key', 'orders', {
      is_unique: true,
      is_primary: false,
      is_valid: true,
      is_replident: false,
      constraint_names: ['order_items_order_fkey', 'orders_id_uniq'],
      constraint_types: ['f', 'u'],
    });
    const fk = disq.find((d) => d.kind === 'constraint-backing' && /foreign key/.test(d.evidence));
    assert.ok(fk, JSON.stringify(disq));
    assert.match(fk.evidence, /`order_items_order_fkey`/);
    assert.match(fk.evidence, /pg_constraint\.conindid/);
    const uq = disq.find((d) => /unique constraint/.test(d.evidence));
    assert.ok(uq);
    assert.match(uq.evidence, /`orders_id_uniq`/);
  });
});

// ── Usage evidence ───────────────────────────────────────────────────────────

describe('interpretIndexInventory: usage evidence', () => {
  test('a plain zero-scan index is droppable, with the counter caveat and reset', () => {
    const [entry] = interpretIndexInventory([row({})], CTX);
    assert.equal(entry.droppableForPerformance, true);
    assert.deepEqual(entry.disqualifiers, []);
    assert.match(entry.evidence, /0 scans/);
    assert.match(entry.evidence, /since statistics were last reset/);
    assert.match(entry.evidence, /2026-06-01T00:00:00\.000Z/);
    assert.match(entry.evidence, /replicas/);
  });

  test("a NULL stats_reset reads as 'since this database's statistics began'", () => {
    const [entry] = interpretIndexInventory([row({})], { statsResetAt: null, hasLastScan: true });
    assert.match(entry.evidence, /since this database's statistics began/);
    assert.doesNotMatch(entry.evidence, /last reset/);
  });

  test('without last_idx_scan there is no last-scan claim and lastScanAt is null', () => {
    const [entry] = interpretIndexInventory(
      [row({ last_scan_at: '2026-07-01T00:00:00Z' })],
      { statsResetAt: null, hasLastScan: false },
    );
    assert.equal(entry.lastScanAt, null);
    assert.doesNotMatch(entry.evidence, /[Ll]ast scanned/);
  });

  test('with last_idx_scan present the sentence cites it', () => {
    const evidence = usageEvidence('idx', 14, CTX, '2026-07-30T18:24:35.887Z');
    assert.match(evidence, /Last scanned 2026-07-30T18:24:35\.887Z \(last_idx_scan\)/);
  });

  test('an invalid index is droppable because the planner never uses it', () => {
    const [entry] = interpretIndexInventory([row({ is_valid: false })], CTX);
    assert.equal(entry.valid, false);
    assert.equal(entry.droppableForPerformance, true);
    assert.match(entry.evidence, /planner never uses an invalid index/);
    assert.match(entry.evidence, /CREATE INDEX CONCURRENTLY/);
    assert.match(entry.evidence, /pg_index\.indisvalid/);
  });

  test('bigint counters arrive as strings from pg and are normalised', () => {
    const [entry] = interpretIndexInventory([row({ scans: '45008', size_bytes: '16220160' })], CTX);
    assert.equal(entry.scans, 45008);
    assert.equal(entry.sizeBytes, 16220160);
  });
});

// ── Proof-set assembly ───────────────────────────────────────────────────────

describe('assembleProofSet', () => {
  test('dedupes the same fingerprint across store and workload — store wins', () => {
    const { queries, skipped } = assembleProofSet(
      [{ fingerprint: 'select count(*) from orders', sql: 'SELECT count(*) FROM orders' }],
      ['SELECT count(*)  FROM orders'],
      20,
    );
    assert.equal(queries.length, 1);
    assert.equal(queries[0].source, 'store');
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].source, 'workload');
    assert.match(skipped[0].reason, /[Dd]uplicate/);
  });

  test('stored SQL is re-admitted, never trusted: writes and stacking are skipped', () => {
    const { queries, skipped } = assembleProofSet(
      [
        { fingerprint: 'fp-1', sql: 'SELECT 1; DROP TABLE orders' },
        { fingerprint: 'fp-2', sql: 'WITH gone AS (DELETE FROM orders RETURNING *) SELECT * FROM gone' },
      ],
      [],
      20,
    );
    assert.equal(queries.length, 0);
    assert.equal(skipped.length, 2);
    assert.match(skipped[0].reason, /Multiple statements/);
    assert.match(skipped[1].reason, /DELETE/);
  });

  test('a $1-parameterised workload text is skipped with the isExplainable reason', () => {
    const { queries, skipped } = assembleProofSet(
      [],
      ['SELECT * FROM orders WHERE id = $1'],
      20,
    );
    assert.equal(queries.length, 0);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].source, 'workload');
    assert.match(skipped[0].reason, /normalised form|\$1/);
  });

  test('the cap truncates at 20 with the flag set and every exclusion disclosed', () => {
    const fromStore = Array.from({ length: 25 }, (_, i) => ({
      fingerprint: `fp-${i}`,
      sql: `SELECT c${i} FROM orders`,
    }));
    const { queries, skipped, capped } = assembleProofSet(fromStore, [], MAX_PROOF_QUERIES);
    assert.equal(queries.length, 20);
    assert.equal(capped, true);
    assert.equal(skipped.length, 5);
    assert.match(skipped[0].reason, /cap of 20/);
  });

  test('empty input assembles empty without throwing — the refusal is the orchestrator’s', () => {
    const { queries, skipped, capped } = assembleProofSet([], [], 20);
    assert.deepEqual(queries, []);
    assert.deepEqual(skipped, []);
    assert.equal(capped, false);
  });
});

// ── Verdict ──────────────────────────────────────────────────────────────────

describe('dropVerdict', () => {
  test("all unchanged → 'no-plan-changed'", () => {
    assert.equal(dropVerdict([perQuery({}), perQuery({})]), 'no-plan-changed');
  });

  test("one restructured plan → 'plans-changed-not-worse'", () => {
    assert.equal(
      dropVerdict([perQuery({}), perQuery({ verdict: 'restructured' })]),
      'plans-changed-not-worse',
    );
  });

  test("any regression condemns the drop, whatever else improved", () => {
    assert.equal(
      dropVerdict([perQuery({ verdict: 'improved' }), perQuery({ verdict: 'regressed' }), perQuery({})]),
      'regressed',
    );
  });

  test('error rows carry no verdict and do not vacuously pass', () => {
    assert.equal(
      dropVerdict([perQuery({ verdict: null, error: 'relation gone' }), perQuery({})]),
      'no-plan-changed',
    );
  });
});

// ── The note ─────────────────────────────────────────────────────────────────

describe('composeDropNote', () => {
  const coverage = { tested: 14, fromStore: 12, fromWorkload: 2, capped: false, cap: 20 };
  const usage = {
    evidence:
      "`promotions_applied_at_idx` has 0 scans since statistics were last reset (pg_stat_user_indexes.idx_scan; reset 2026-06-01T00:00:00.000Z) — the counter cannot see usage before a reset, reads served by replicas, or constraint enforcement.",
  };

  test('a regressed note names the worst query, its cost pair, and says do not drop', () => {
    const rows = [
      perQuery({}),
      perQuery({
        sql: 'SELECT * FROM order_items WHERE order_id = 12345',
        verdict: 'regressed',
        costBefore: 11,
        costAfter: 11050,
        costChange: 963.21,
        accessChanges: ['Index Scan using order_items_order_id_idx on order_items: no longer uses index order_items_order_id_idx'],
      }),
    ];
    const note = composeDropNote({ name: 'order_items_order_id_idx' }, usage, rows, coverage, 'regressed');
    assert.match(note, /`order_items_order_id_idx` is load-bearing/);
    assert.match(note, /cost 11 → 11050/);
    assert.match(note, /\+96321%/);
    assert.match(note, /order_items_order_id_idx on order_items/);
    assert.match(note, /queries this agent knows about \(12 from history, 2 from the workload\)/);
    assert.match(note, /estimates/);
    assert.match(note, /Do not drop it/);
  });

  test('the worst regression is chosen by cost change, not list order', () => {
    const rows = [
      perQuery({ sql: 'SELECT a FROM t1', verdict: 'regressed', costBefore: 10, costAfter: 20, costChange: 1 }),
      perQuery({ sql: 'SELECT b FROM t2', verdict: 'regressed', costBefore: 5, costAfter: 500, costChange: 99 }),
    ];
    const note = composeDropNote({ name: 'i' }, usage, rows, coverage, 'regressed');
    assert.match(note, /SELECT b FROM t2/);
  });

  test('a no-plan-changed note cites the hide, the coverage, and the counter caveat', () => {
    const note = composeDropNote(
      { name: 'promotions_applied_at_idx' },
      usage,
      [perQuery({})],
      coverage,
      'no-plan-changed',
    );
    assert.match(note, /hypopg_hide_index/);
    assert.match(note, /hypopg_hidden_indexes/);
    assert.match(note, /changed no plan/);
    assert.match(note, /queries this agent knows about/);
    assert.match(note, /since statistics were last reset/);
    assert.match(note, /Safe to drop against these queries/);
    assert.match(note, /never analysed here are not covered/);
    assert.match(note, /estimates/);
  });

  test('capped coverage appears in the sentence', () => {
    const note = composeDropNote(
      { name: 'i' },
      usage,
      [perQuery({})],
      { ...coverage, capped: true },
      'no-plan-changed',
    );
    assert.match(note, /capped at 20/);
  });

  test('plans-changed-not-worse counts the moved plans and shows an access change', () => {
    const rows = [
      perQuery({}),
      perQuery({
        verdict: 'restructured',
        accessChanges: ['Seq Scan on orders: now uses index orders_status_idx'],
      }),
    ];
    const note = composeDropNote({ name: 'i' }, usage, rows, coverage, 'plans-changed-not-worse');
    assert.match(note, /changed 1 plan, none for the worse/);
    assert.match(note, /now uses index orders_status_idx/);
    assert.match(note, /Review the changed plans/);
  });

  test('error rows are counted in the note, not silently dropped', () => {
    const rows = [perQuery({}), perQuery({ verdict: null, headline: null, error: 'relation "gone" does not exist' })];
    const note = composeDropNote({ name: 'i' }, usage, rows, { ...coverage, tested: 2 }, 'no-plan-changed');
    assert.match(note, /1 of 2 could not be planned/);
  });
});
