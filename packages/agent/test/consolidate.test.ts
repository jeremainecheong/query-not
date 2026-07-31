/**
 * Scope assembly tests — pure, no database.
 *
 * The load-bearing behavior is the §6.1 answer: a normalised `$1` entry never
 * gets guessed parameters. Either a saved query with representative literals
 * stands in for it — carrying the entry's measured weight — or the entry is
 * skipped with the reason on record.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { ConsolidatedIndex } from '@query-not/core';

import {
  buildScope,
  matchKey,
  summarizeCandidate,
  type ConsolidationPerQuery,
} from '../src/consolidate.ts';
import { fingerprint } from '../src/safety.ts';
import type { SavedQuery } from '../src/store.ts';
import type { RankedEntry } from '../src/workload.ts';

function entry(queryId: string, query: string, share: number): RankedEntry {
  return {
    queryId,
    query,
    calls: 10,
    totalMs: share * 1000,
    meanMs: share * 100,
    stddevMs: null,
    rows: 10,
    sharedHit: 0,
    sharedRead: 0,
    share,
    flags: [],
    note: null,
  };
}

function savedQuery(name: string, sql: string): SavedQuery {
  return {
    id: 1,
    name,
    sql,
    fingerprint: fingerprint(sql),
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    latestSlug: null,
    runCount: 0,
  };
}

/** One proof row, defaulting to an unclaimed, un-re-planned sentinel. */
function pq(over: Partial<ConsolidationPerQuery> & { fingerprint: string }): ConsolidationPerQuery {
  return {
    queryId: null,
    savedName: null,
    source: 'workload',
    share: 0,
    claimed: false,
    verdict: null,
    costBefore: null,
    costAfter: null,
    costChange: null,
    headline: null,
    accessChanges: [],
    error: null,
    ...over,
  };
}

function candidate(over: Partial<ConsolidatedIndex> = {}): ConsolidatedIndex {
  return {
    relation: 'orders',
    columns: ['status', 'created_at'],
    roles: ['eq', 'range'],
    ddl: 'CREATE INDEX CONCURRENTLY ON orders (status, created_at);',
    rationale: 'test candidate',
    weight: 0.5,
    claims: [],
    replaces: [],
    ...over,
  };
}

describe('matchKey', () => {
  test('a saved query with literals matches the pg_stat_statements normalisation', () => {
    assert.equal(
      matchKey("SELECT * FROM orders WHERE status = 'disputed' AND created_at > '2024-03-01'"),
      matchKey('SELECT * FROM orders WHERE status = $1 AND created_at > $2'),
    );
  });

  test('whitespace inside IN lists does not defeat the match', () => {
    assert.equal(
      matchKey('SELECT id FROM orders WHERE id IN (1, 2, 3)'),
      matchKey('SELECT id FROM orders WHERE id IN ($1,$2,$3)'),
    );
  });

  test('different statements stay different', () => {
    assert.notEqual(
      matchKey('SELECT id FROM orders WHERE status = $1'),
      matchKey('SELECT id FROM customers WHERE country = $1'),
    );
  });
});

describe('buildScope', () => {
  const opts = { limit: 12, includeSaved: true };

  test('an explainable entry joins as itself', () => {
    const { members, skipped } = buildScope(
      [entry('11', "SELECT * FROM orders WHERE status = 'disputed'", 0.4)],
      [],
      opts,
    );
    assert.equal(skipped.length, 0);
    assert.equal(members.length, 1);
    assert.equal(members[0]?.source, 'workload');
    assert.equal(members[0]?.share, 0.4);
    assert.equal(members[0]?.queryId, '11');
  });

  test('a normalised entry takes a matching saved query as its stand-in, keeping the entry\'s share', () => {
    const { members, skipped } = buildScope(
      [entry('11', 'SELECT * FROM orders WHERE status = $1', 0.35)],
      [savedQuery('by-status', "SELECT * FROM orders WHERE status = 'disputed'")],
      opts,
    );
    assert.equal(skipped.length, 0);
    assert.equal(members.length, 1);
    const m = members[0];
    assert.ok(m);
    assert.equal(m.source, 'saved-matched');
    assert.equal(m.sql, "SELECT * FROM orders WHERE status = 'disputed'", 'the saved SQL is what gets planned');
    assert.equal(m.share, 0.35, 'the workload entry supplies the weight');
    assert.equal(m.savedName, 'by-status');
  });

  test('an unmatched normalised entry is skipped with the reason and the save-a-variant hint', () => {
    const { members, skipped } = buildScope(
      [entry('11', 'SELECT * FROM orders WHERE status = $1', 0.35)],
      [],
      opts,
    );
    assert.equal(members.length, 0);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0]?.reason ?? '', /normalised form/);
    assert.match(skipped[0]?.hint ?? '', /runnable variant/);
    assert.equal(skipped[0]?.share, 0.35, 'the skipped weight stays visible');
  });

  test('a recorded utility statement is skipped with the admission reason', () => {
    const { skipped } = buildScope(
      [entry('11', 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM orders WHERE status = $1', 0.2)],
      [],
      opts,
    );
    assert.equal(skipped.length, 1);
    assert.match(skipped[0]?.reason ?? '', /EXPLAIN/);
  });

  test('unmatched saved queries join with zero share when includeSaved', () => {
    const { members } = buildScope(
      [],
      [savedQuery('extra', "SELECT * FROM orders WHERE status = 'pending'")],
      opts,
    );
    assert.equal(members.length, 1);
    assert.equal(members[0]?.source, 'saved-extra');
    assert.equal(members[0]?.share, 0, 'a saved extra carries no window weight');
  });

  test('includeSaved: false leaves saved queries out entirely', () => {
    const { members } = buildScope(
      [],
      [savedQuery('extra', "SELECT * FROM orders WHERE status = 'pending'")],
      { limit: 12, includeSaved: false },
    );
    assert.equal(members.length, 0);
  });

  test('duplicate fingerprints collapse and sum their shares', () => {
    // A normalised entry standing in through a saved query, and a literal
    // entry that fingerprints to the same planned shape: one scope member,
    // pooled weight — the same statement is never planned twice.
    const { members, skipped } = buildScope(
      [
        entry('11', 'SELECT id FROM orders WHERE id IN ($1, $2)', 0.2),
        entry('12', 'SELECT id FROM orders WHERE id IN (1, 2)', 0.1),
      ],
      [savedQuery('by-ids', 'SELECT id FROM orders WHERE id IN (5, 6)')],
      opts,
    );
    assert.equal(skipped.length, 0);
    assert.equal(members.length, 1);
    assert.ok(Math.abs((members[0]?.share ?? 0) - 0.3) < 1e-9, String(members[0]?.share));
  });

  test('an inadmissible saved query is skipped with the admission reason', () => {
    const { members, skipped } = buildScope(
      [],
      [savedQuery('bad', 'DELETE FROM orders')],
      opts,
    );
    assert.equal(members.length, 0);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0]?.savedName, 'bad');
    assert.match(skipped[0]?.reason ?? '', /Refusing to run/);
  });

  test('entries beyond the limit are not considered', () => {
    const { members, skipped } = buildScope(
      [
        entry('1', "SELECT * FROM orders WHERE status = 'a'", 0.5),
        entry('2', "SELECT * FROM orders WHERE status = 'b'", 0.3),
      ],
      [],
      { limit: 1, includeSaved: true },
    );
    assert.equal(members.length, 1);
    assert.equal(skipped.length, 0);
    assert.equal(members[0]?.queryId, '1');
  });
});

describe('buildScope — the saved-query contribution is capped by `limit`', () => {
  test('saved extras stop at `limit`; the overflow is disclosed, never silent', () => {
    // Each saved extra becomes a scope member that costs an EXPLAIN plus a
    // whatIfIndex per candidate — so an unbounded saved set is exactly the
    // unbounded-proof-matrix defect. The cap bounds it to `limit`.
    // Distinct tables so each has its own fingerprint — identical fingerprints
    // would dedupe before the cap, which is a different (also-correct) path.
    const saved = Array.from({ length: 5 }, (_, i) =>
      savedQuery(`s${i}`, `SELECT * FROM t${i} WHERE col = 'x'`),
    );
    const { members, skipped, savedExtras } = buildScope([], saved, {
      limit: 2,
      includeSaved: true,
    });
    assert.equal(members.filter((m) => m.source === 'saved-extra').length, 2, 'only `limit` extras admitted');
    assert.deepEqual(savedExtras, { cap: 2, included: 2, omitted: 3 });
    // The truncation surfaces in a single bounded skip entry, no matter how
    // large the saved set is.
    const capSkip = skipped.find((s) => /capped at 2/.test(s.reason));
    assert.ok(capSkip, 'the cap is disclosed in skipped');
    assert.match(capSkip?.reason ?? '', /3 more saved queries were not proved/);
  });

  test('inadmissible and already-in-scope saved queries are not charged against the cap', () => {
    // Neither a saved query already covered by the window nor an inadmissible
    // one costs an EXPLAIN, so neither consumes a cap slot — a single genuine
    // extra still gets in under limit 1.
    const { members, savedExtras, skipped } = buildScope(
      [entry('11', "SELECT * FROM orders WHERE status = 'a'", 0.4)],
      [
        savedQuery('dupe', "SELECT * FROM orders WHERE status = 'a'"),
        savedQuery('bad', 'DELETE FROM orders'),
        savedQuery('extra', "SELECT * FROM customers WHERE country = 'sg'"),
      ],
      { limit: 1, includeSaved: true },
    );
    assert.deepEqual(savedExtras, { cap: 1, included: 1, omitted: 0 });
    assert.equal(members.filter((m) => m.source === 'saved-extra').length, 1);
    assert.ok(skipped.some((s) => s.savedName === 'bad'), 'the inadmissible one is skipped for its own reason');
    assert.ok(!skipped.some((s) => /capped/.test(s.reason)), 'nothing was capped, so no cap skip');
  });

  test('includeSaved: false reports an empty, un-capped saved contribution', () => {
    const { savedExtras } = buildScope(
      [],
      [savedQuery('extra', "SELECT * FROM orders WHERE status = 'p'")],
      { limit: 5, includeSaved: false },
    );
    assert.deepEqual(savedExtras, { cap: 5, included: 0, omitted: 0 });
  });
});

describe('summarizeCandidate — the verdict and its honest wording', () => {
  test('a regressed CLAIMED statement condemns the candidate: do not apply', () => {
    const r = summarizeCandidate(candidate({ claims: ['q1'] }), [
      pq({ fingerprint: 'q1', claimed: true, verdict: 'regressed', share: 0.3, costChange: 0.4 }),
    ]);
    assert.equal(r.verdict, 'regressed');
    assert.equal(r.regressed, 1);
    assert.match(r.summary, /do not apply/);
  });

  test('a regressed SENTINEL condemns the candidate even when a claimed row improved', () => {
    // The safety invariant that had no test: any regression — a claimed
    // statement or an unclaimed sentinel — flips the verdict to do-not-apply,
    // overriding served rows.
    const r = summarizeCandidate(candidate({ claims: ['q1'] }), [
      pq({ fingerprint: 'q1', claimed: true, verdict: 'improved', share: 0.4 }),
      pq({ fingerprint: 'q2', claimed: false, verdict: 'regressed', share: 0.2 }),
    ]);
    assert.equal(r.verdict, 'regressed', 'a sentinel regression still condemns');
    assert.equal(r.regressed, 1);
    assert.match(r.summary, /Regresses 1 statement of the 2 it re-planned — do not apply/);
  });

  test('an errored row counts as neither served nor safe, and never inflates "regresses none"', () => {
    // 2 served, 1 errored (whatIfIndex threw). The claim quantifies over the 2
    // re-planned, and the error is disclosed — never folded into "of the 3".
    const r = summarizeCandidate(candidate({ claims: ['q1', 'q2'] }), [
      pq({ fingerprint: 'q1', claimed: true, verdict: 'improved', share: 0.4 }),
      pq({ fingerprint: 'q2', claimed: true, verdict: 'improved', share: 0.2 }),
      pq({ fingerprint: 'q3', claimed: false, verdict: null, error: 'statement timeout', share: 0.1 }),
    ]);
    assert.equal(r.verdict, 'improved');
    assert.equal(r.served, 2);
    assert.match(r.summary, /Serves 2 of the 2 statements it re-planned/);
    assert.match(r.summary, /regresses none of the 2/);
    assert.match(r.summary, /1 of 3 could not be planned and is excluded/);
    assert.doesNotMatch(r.summary, /regresses none of the 3/, 'the untested row must not read as safe');
  });

  test('a candidate whose every proof errored is not a pass — it "could not be tested"', () => {
    const r = summarizeCandidate(candidate({ claims: ['q1'] }), [
      pq({ fingerprint: 'q1', claimed: true, verdict: null, error: 'relation dropped', share: 0.3 }),
    ]);
    assert.equal(r.served, 0);
    assert.equal(r.regressed, 0);
    assert.match(r.summary, /Could not be tested/);
    assert.doesNotMatch(r.summary, /wins nothing/, 'zero evidence must not read as a proven no-op');
    assert.doesNotMatch(r.summary, /regresses none/);
  });

  test('an equal-cost adoption (restructured) is reported as adopted, not "declined" / "wins nothing"', () => {
    // The planner DID adopt the hypothetical index, at near-equal cost, so no
    // claimed row is 'improved' and the candidate lands in the 'unchanged'
    // bucket. The old wording called this "declined … wins nothing" — the exact
    // claim the per-query "now uses index …" row contradicts.
    const r = summarizeCandidate(
      candidate({ claims: ['q1'], replaces: [{ relation: 'orders', columns: ['status'] }] }),
      [
        pq({
          fingerprint: 'q1',
          claimed: true,
          verdict: 'restructured',
          share: 0.4,
          accessChanges: ['Seq Scan on orders: now uses index hypothetical btree_orders_status_created_at'],
        }),
      ],
    );
    assert.equal(r.verdict, 'unchanged');
    assert.match(r.summary, /adopted this index/);
    assert.doesNotMatch(r.summary, /declined/);
    assert.doesNotMatch(r.summary, /wins nothing/);
    assert.match(r.summary, /replace 1 narrower single-query index at no estimated cost/);
  });

  test('a genuine same-plan no-op still reads "wins nothing", and cites a kept plan not a decline', () => {
    const r = summarizeCandidate(candidate({ claims: ['q1'] }), [
      pq({ fingerprint: 'q1', claimed: true, verdict: 'unchanged', share: 0.4 }),
    ]);
    assert.equal(r.verdict, 'unchanged');
    assert.match(r.summary, /wins nothing on this database/);
    assert.match(r.summary, /kept the existing plan/);
  });

  test('a served candidate weights by window share and reports what it replaces', () => {
    const r = summarizeCandidate(
      candidate({ claims: ['q1'], replaces: [{ relation: 'orders', columns: ['status'] }] }),
      [
        pq({ fingerprint: 'q1', claimed: true, verdict: 'improved', share: 0.5 }),
        pq({ fingerprint: 'q2', claimed: false, verdict: 'unchanged', share: 0.1 }),
      ],
    );
    assert.equal(r.verdict, 'improved');
    assert.equal(r.served, 1);
    assert.ok(Math.abs(r.servedShare - 0.5) < 1e-9);
    assert.match(r.summary, /Serves 1 of the 2 statements it re-planned/);
    assert.match(r.summary, /50% of all query time in this window/);
    assert.match(r.summary, /would replace 1 narrower single-query index/);
  });

  test('served rows that all sit outside the window say so instead of claiming 0%', () => {
    // Saved extras carry share 0; a candidate served only by them has no window
    // share to weight by, and the summary must say that rather than "0%".
    const r = summarizeCandidate(candidate({ claims: ['s1'] }), [
      pq({ fingerprint: 's1', claimed: true, verdict: 'improved', share: 0, source: 'saved-extra', savedName: 'nightly' }),
    ]);
    assert.equal(r.verdict, 'improved');
    assert.match(r.summary, /all outside the measured window/);
  });
});
