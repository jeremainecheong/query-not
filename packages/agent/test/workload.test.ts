/**
 * Workload delta tests.
 *
 * These cover the three things that make pg_stat_statements harder to read
 * than it looks — cumulative counters, resets, and eviction — because each one
 * produces plausible-looking nonsense if handled naively.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { deltaWorkload, isExplainable, rankWorkload, type WorkloadEntry } from '../src/workload.ts';

function entry(id: string, calls: number, totalMs: number, over: Partial<WorkloadEntry> = {}): WorkloadEntry {
  return {
    queryId: id,
    query: `SELECT ${id}`,
    calls,
    totalMs,
    meanMs: calls > 0 ? totalMs / calls : 0,
    stddevMs: null,
    rows: calls,
    sharedHit: 0,
    sharedRead: 0,
    ...over,
  };
}

describe('deltaWorkload', () => {
  test('the first snapshot is reported whole', () => {
    const { entries, resetDetected } = deltaWorkload(null, [entry('a', 100, 500)]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.calls, 100);
    assert.equal(resetDetected, false);
  });

  test('subtracts cumulative counters into a window', () => {
    const before = [entry('a', 100, 500)];
    const after = [entry('a', 150, 800)];
    const { entries } = deltaWorkload(before, after);
    assert.equal(entries[0]?.calls, 50);
    assert.equal(entries[0]?.totalMs, 300);
  });

  test('recomputes mean from the window, not the lifetime', () => {
    // Lifetime mean is 800/150 = 5.3ms, but in this window it averaged 6ms.
    // Reporting the lifetime figure would hide a query that just got slower.
    const { entries } = deltaWorkload([entry('a', 100, 500)], [entry('a', 150, 800)]);
    assert.equal(entries[0]?.meanMs, 6);
  });

  test('a query that did not run in the window is excluded', () => {
    const { entries } = deltaWorkload([entry('a', 100, 500)], [entry('a', 100, 500)]);
    assert.equal(entries.length, 0);
  });

  describe('counter resets', () => {
    test('a decrease is treated as a reset, not negative work', () => {
      const { entries, resetDetected } = deltaWorkload([entry('a', 1000, 5000)], [entry('a', 12, 60)]);
      assert.equal(resetDetected, true);
      assert.equal(entries[0]?.calls, 12, 'after a reset the current value is the window');
      assert.ok((entries[0]?.totalMs ?? 0) > 0, 'must never report negative time');
    });

    test('time going backwards alone is enough to detect a reset', () => {
      const { resetDetected } = deltaWorkload([entry('a', 10, 5000)], [entry('a', 11, 60)]);
      assert.equal(resetDetected, true);
    });

    test('no delta is ever negative', () => {
      const { entries } = deltaWorkload(
        [entry('a', 500, 900, { rows: 900, sharedHit: 400, sharedRead: 300 })],
        [entry('a', 5, 9, { rows: 9, sharedHit: 4, sharedRead: 3 })],
      );
      for (const e of entries) {
        assert.ok(e.calls >= 0 && e.totalMs >= 0 && e.rows >= 0 && e.sharedHit >= 0 && e.sharedRead >= 0);
      }
    });
  });

  describe('eviction', () => {
    test('a query absent from the previous snapshot counts in full', () => {
      // It was evicted and came back, or is newly seen. Either way we know it
      // ran at least this much; treating it as zero would under-report.
      const { entries } = deltaWorkload([entry('a', 100, 500)], [entry('a', 110, 550), entry('b', 40, 900)]);
      const b = entries.find((e) => e.queryId === 'b');
      assert.ok(b);
      assert.equal(b.calls, 40);
    });

    test('a query absent from the current snapshot is simply not in the window', () => {
      const { entries } = deltaWorkload([entry('a', 100, 500), entry('b', 10, 20)], [entry('a', 110, 550)]);
      assert.equal(entries.some((e) => e.queryId === 'b'), false);
    });
  });

  test('ranks by total time, not by mean', () => {
    // The whole point: the 2ms query running constantly outranks the slow one.
    const { entries } = deltaWorkload(null, [
      entry('slow-report', 2, 4000),
      entry('hot-path', 900_000, 1_800_000),
    ]);
    assert.equal(entries[0]?.queryId, 'hot-path');
  });
});

describe('rankWorkload', () => {
  test('computes each entry’s share of the window', () => {
    const { ranked, totalMs } = rankWorkload([entry('a', 10, 750), entry('b', 10, 250)]);
    assert.equal(totalMs, 1000);
    assert.equal(ranked[0]?.share, 0.75);
  });

  test('flags a cheap query that dominates by volume', () => {
    const { ranked } = rankWorkload([
      entry('hot', 500_000, 1_000_000),
      entry('other', 10, 100),
    ]);
    const hot = ranked.find((r) => r.queryId === 'hot');
    assert.ok(hot?.flags.includes('high-frequency'),
      `expected high-frequency, got ${hot?.flags.join(',')}`);
    assert.match(hot.note as string, /slow-query log never shows you/);
  });

  test('flags runtime variance as plan instability', () => {
    const { ranked } = rankWorkload([entry('v', 1000, 10_000, { stddevMs: 40, meanMs: 10 })]);
    assert.ok(ranked[0]?.flags.includes('unstable'));
    assert.match(ranked[0]?.note as string, /plan changes with the parameter values/);
  });

  test('flags a cold working set', () => {
    const { ranked } = rankWorkload([entry('c', 100, 500, { sharedHit: 2000, sharedRead: 20_000 })]);
    assert.ok(ranked[0]?.flags.includes('cold-cache'));
  });

  test('a healthy workload gets no flags', () => {
    const { ranked } = rankWorkload([
      entry('a', 100, 300, { stddevMs: 1, meanMs: 3, sharedHit: 500, sharedRead: 1 }),
      entry('b', 100, 300, { stddevMs: 1, meanMs: 3, sharedHit: 500, sharedRead: 1 }),
      entry('c', 100, 300, { stddevMs: 1, meanMs: 3, sharedHit: 500, sharedRead: 1 }),
      entry('d', 100, 300, { stddevMs: 1, meanMs: 3, sharedHit: 500, sharedRead: 1 }),
      entry('e', 100, 300, { stddevMs: 1, meanMs: 3, sharedHit: 500, sharedRead: 1 }),
      entry('f', 100, 300, { stddevMs: 1, meanMs: 3, sharedHit: 500, sharedRead: 1 }),
    ]);
    assert.equal(ranked.every((r) => r.flags.length === 0), true,
      ranked.map((r) => `${r.queryId}:${r.flags.join('/')}`).join(' '));
  });

  test('an empty workload does not divide by zero', () => {
    const { ranked, totalMs } = rankWorkload([]);
    assert.equal(totalMs, 0);
    assert.equal(ranked.length, 0);
  });
});

describe('isExplainable', () => {
  test('rejects the normalised form, explaining why', () => {
    // The parameter problem from REQUIREMENTS.md §6.1 — the honest answer is
    // to say so, not to fail with a syntax error.
    const result = isExplainable('SELECT * FROM orders WHERE status = $1');
    assert.equal(result.ok, false);
    assert.match(result.reason as string, /placeholders|parameters/i);
  });

  test('rejects truncated query text', () => {
    assert.equal(isExplainable('SELECT a, b, c FROM ...').ok, false);
  });

  test('accepts a query with no placeholders', () => {
    assert.equal(isExplainable('SELECT count(*) FROM orders').ok, true);
  });
});
