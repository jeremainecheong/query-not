import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAggregateProbe,
  buildCatalogProbe,
  buildUniqueIndexProbe,
  buildVolatilityProbe,
  interpretAggregateChecks,
  interpretIsAggregateChecks,
  interpretChecks,
  interpretUniqueChecks,
  relationKey,
  type CatalogRow,
  type UniqueIndexRow,
} from '../src/catalog.ts';
import type { PreconditionSpec } from '../src/transform.ts';

const notNull = (relation: string[], column: string): PreconditionSpec => ({
  kind: 'column-not-null',
  relation,
  column,
  role: 'outer',
  why: 'NOT IN filters a row whose left-hand value is NULL; NOT EXISTS keeps it.',
});

const typed = (relation: string[], column: string): PreconditionSpec => ({
  kind: 'column-type-supported',
  relation,
  column,
  oneOf: ['date', 'timestamp without time zone', 'timestamp with time zone'],
  why: 'The half-open range is equivalent to date() only for a date or timestamp column.',
});

const row = (over: Partial<CatalogRow>): CatalogRow => ({
  rel: 'orders',
  col: 'id',
  rel_exists: true,
  relkind: 'r',
  attnotnull: true,
  type_name: 'bigint',
  ...over,
});

const TZ = { timeZone: 'Asia/Singapore' };

describe('probe construction', () => {
  test('one statement, parallel arrays, resolved through to_regclass', () => {
    const probe = buildCatalogProbe([notNull(['public', 'orders'], 'id'), typed(['promotions'], 'applied_at')]);
    assert.match(probe.text, /unnest\(\$1::text\[\], \$2::text\[\]\)/);
    assert.match(probe.text, /to_regclass/);
    assert.match(probe.text, /NOT a\.attisdropped/);
    assert.deepEqual(probe.values, [['public.orders', 'promotions'], ['id', 'applied_at']]);
  });

  test('identifiers that need quoting get it', () => {
    // The relation string goes through to_regclass, which parses quoting.
    assert.equal(relationKey(notNull(['weird name', 'Order Items'], 'x')), '"weird name"."Order Items"');
  });

  test('volatility probe matches by name', () => {
    const p = buildVolatilityProbe(['random', 'now']);
    assert.match(p.text, /provolatile = 'v'/);
    assert.deepEqual(p.values, [['random', 'now']]);
  });
});

describe('interpretation', () => {
  test('NOT NULL established cites pg_attribute', () => {
    const [check] = interpretChecks([notNull(['orders'], 'id')], [row({})], TZ);
    assert.equal(check.established, true);
    assert.match(check.evidence, /orders\.id.*NOT NULL.*attnotnull/);
  });

  test('a nullable column fails with the divergence spelled out', () => {
    const [check] = interpretChecks(
      [notNull(['promotions'], 'order_id')],
      [row({ rel: 'promotions', col: 'order_id', attnotnull: false })],
      TZ,
    );
    assert.equal(check.established, false);
    assert.match(check.evidence, /nullable/);
    assert.match(check.evidence, /NOT EXISTS/);
  });

  test('an unresolvable relation fails without guessing', () => {
    const [check] = interpretChecks(
      [notNull(['nope'], 'x')],
      [row({ rel: 'nope', col: 'x', rel_exists: false, relkind: null, attnotnull: null, type_name: null })],
      TZ,
    );
    assert.equal(check.established, false);
    assert.match(check.evidence, /does not resolve/);
  });

  test('a view fails: attnotnull is a fact about storage', () => {
    const [check] = interpretChecks(
      [notNull(['v_orders'], 'id')],
      [row({ rel: 'v_orders', relkind: 'v' })],
      TZ,
    );
    assert.equal(check.established, false);
    assert.match(check.evidence, /view/);
  });

  test('a missing column names itself', () => {
    const [check] = interpretChecks(
      [notNull(['orders'], 'ghost')],
      [row({ col: 'ghost', attnotnull: null, type_name: null })],
      TZ,
    );
    assert.equal(check.established, false);
    assert.match(check.evidence, /ghost.*does not exist/);
  });

  test('a supported timestamp type is established without hedging', () => {
    const [check] = interpretChecks(
      [typed(['promotions'], 'applied_at')],
      [row({ rel: 'promotions', col: 'applied_at', type_name: 'timestamp without time zone' })],
      TZ,
    );
    assert.equal(check.established, true);
    assert.doesNotMatch(check.evidence, /TimeZone/);
  });

  test('timestamptz cites the session TimeZone it was established under', () => {
    const [check] = interpretChecks(
      [typed(['orders'], 'created_at')],
      [row({ col: 'created_at', type_name: 'timestamp with time zone' })],
      TZ,
    );
    assert.equal(check.established, true);
    assert.match(check.evidence, /Asia\/Singapore/);
  });

  test('an unsupported type fails and says what would work', () => {
    const [check] = interpretChecks(
      [typed(['orders'], 'note')],
      [row({ col: 'note', type_name: 'text' })],
      TZ,
    );
    assert.equal(check.established, false);
    assert.match(check.evidence, /is text/);
    assert.match(check.evidence, /date, timestamp/);
  });

  test('a probe row that never came back reads as unresolvable, not as established', () => {
    const [check] = interpretChecks([notNull(['orders'], 'id')], [], TZ);
    assert.equal(check.established, false);
  });
});

// ── Tier B probes ────────────────────────────────────────────────────────────

const uniqueSpec = (relation: string[], columns: string[]) => ({
  kind: 'unique-key-covers' as const,
  relation,
  columns,
  why: 'The scalar subquery raised an error on a second matching row; the join would silently duplicate the outer row instead.',
});

const aggSpec = (functions: string[]) => ({
  kind: 'function-not-aggregate' as const,
  functions,
  why: 'The arms each run the select list; an aggregate there would collapse each arm separately.',
});

const isAggSpec = (functions: string[]) => ({
  kind: 'function-is-aggregate' as const,
  functions,
  why: 'The grouped-join rewrite moves the call into a GROUP BY derived table; a plain function of the same name would compute something else.',
});

describe('unique-index probe', () => {
  test('one statement: unique, non-partial, non-expression, key within the pinned set', () => {
    const probe = buildUniqueIndexProbe([uniqueSpec(['public', 'users'], ['id'])]);
    assert.match(probe.text, /indisunique/);
    assert.match(probe.text, /indpred IS NULL/);
    assert.match(probe.text, /indexprs IS NULL/);
    assert.match(probe.text, /<@/);
    assert.match(probe.text, /k\.ord <= i\.indnkeyatts/);
    assert.deepEqual(JSON.parse(probe.values[0]), [{ rel: 'public.users', cols: ['id'] }]);
  });

  test('a found index establishes the fact and is cited by name', () => {
    const [check] = interpretUniqueChecks(
      [uniqueSpec(['users'], ['id'])],
      [{ idx: 0, rel_exists: true, index_name: 'users_pkey' }],
    );
    assert.equal(check.established, true);
    assert.match(check.evidence, /users_pkey/);
    assert.match(check.evidence, /pg_index\.indisunique/);
    assert.match(check.evidence, /at most one row per \(id\)/);
  });

  test('no covering index fails with the fan-out reason; a missing relation says so', () => {
    const [none] = interpretUniqueChecks(
      [uniqueSpec(['orders'], ['user_id'])],
      [{ idx: 0, rel_exists: true, index_name: null }],
    );
    assert.equal(none.established, false);
    assert.match(none.evidence, /no unique index on `orders`/);
    assert.match(none.evidence, /duplicate the outer row/);

    const [gone] = interpretUniqueChecks([uniqueSpec(['nope'], ['id'])], [
      { idx: 0, rel_exists: false, index_name: null },
    ]);
    assert.equal(gone.established, false);
    assert.match(gone.evidence, /search_path/);
  });

  test('rows map back to specs by position, not by arrival order', () => {
    const rows: UniqueIndexRow[] = [
      { idx: 1, rel_exists: true, index_name: 'b_pkey' },
      { idx: 0, rel_exists: true, index_name: null },
    ];
    const checks = interpretUniqueChecks([uniqueSpec(['a'], ['x']), uniqueSpec(['b'], ['y'])], rows);
    assert.equal(checks[0].established, false);
    assert.equal(checks[1].established, true);
    assert.match(checks[1].evidence, /b_pkey/);
  });
});

describe('aggregate probe', () => {
  test('asks pg_proc for prokind = a over the harvested names', () => {
    const probe = buildAggregateProbe(['sum', 'upper']);
    assert.match(probe.text, /prokind = 'a'/);
    assert.deepEqual(probe.values, [['sum', 'upper']]);
  });

  test('an aggregate among the names fails with the reason; none establishes', () => {
    const [hit] = interpretAggregateChecks([aggSpec(['sum', 'upper'])], ['sum']);
    assert.equal(hit.established, false);
    assert.match(hit.evidence, /`sum\(\)` is an aggregate/);
    assert.match(hit.evidence, /prokind/);

    const [miss] = interpretAggregateChecks([aggSpec(['upper', 'coalesce'])], []);
    assert.equal(miss.established, true);
    assert.match(miss.evidence, /not aggregate functions/);
  });
});

describe('is-aggregate probe (mirror direction)', () => {
  // The probe is name-based, so the positive claim is only ever about the
  // NAME: search_path could resolve `count` to a plain function even while
  // pg_catalog.count exists. The note must say the name "names an aggregate",
  // not that this call "is" one — a resolution the probe cannot see.
  test('a name-match establishes the name, not the call — no `()`, no resolution asserted', () => {
    const [check] = interpretIsAggregateChecks([isAggSpec(['count'])], ['count']);
    assert.equal(check.established, true);
    assert.match(check.evidence, /`count` names an aggregate in pg_proc \(prokind = 'a'\)/);
    assert.doesNotMatch(check.evidence, /`count\(\)`/);
    assert.doesNotMatch(check.evidence, /is an aggregate/);
  });

  // The negative direction IS sound for the call: if no aggregate of that name
  // exists anywhere in pg_proc, nothing can resolve to one — so here we may
  // speak of `count()` and its resolution directly.
  test('a name with no aggregate anywhere refuses, citing the call it can see', () => {
    const [check] = interpretIsAggregateChecks([isAggSpec(['count'])], []);
    assert.equal(check.established, false);
    assert.match(check.evidence, /`count\(\)` does not resolve to an aggregate/);
  });
});
