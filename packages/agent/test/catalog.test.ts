import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCatalogProbe,
  buildVolatilityProbe,
  interpretChecks,
  relationKey,
  type CatalogRow,
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
