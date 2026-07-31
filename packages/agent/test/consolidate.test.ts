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

import { buildScope, matchKey } from '../src/consolidate.ts';
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
