import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'libpg-query';
import { parseExplainJson } from '@query-not/core';

import { initParser } from '../src/rewrite.ts';
import { admitQuery } from '../src/safety.ts';
import {
  accessSignature,
  buildStatsProbe,
  buildVariants,
  chooseSite,
  discoverPredicates,
  findFlips,
  hasParamRef,
  interpretStats,
  parseArrayLiteral,
  quoteLiteral,
  toTextArray,
  validateConstSplice,
  type FlipPoint,
  type PredicateSite,
  type SiteStats,
  type StatsRow,
} from '../src/sensitivity.ts';

before(async () => {
  await initParser();
});

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../core/test/fixtures');
const fixturePlan = (name: string) => parseExplainJson(readFileSync(join(FIXTURES, name), 'utf8'));

const discover = (sql: string) => discoverPredicates(sql, parseSync(sql));

/** The usable sites of a statement, in discovery order. */
const sitesOf = (sql: string): PredicateSite[] =>
  discover(sql)
    .map((d) => d.site)
    .filter((s): s is PredicateSite => s !== null);

const skipsOf = (sql: string): string[] =>
  discover(sql)
    .map((d) => d.candidate.skipped)
    .filter((s): s is string => s !== null);

/** A SiteStats with everything defaulted, for variant-construction tests. */
const stats = (over: Partial<SiteStats>): SiteStats => ({
  reltuples: 400000,
  nullFrac: 0,
  nDistinct: -1,
  mcv: null,
  mcvFreqs: null,
  histogram: null,
  basis: 'histogram',
  evidence: 'test evidence',
  ...over,
});

// ── discovery ────────────────────────────────────────────────────────────────

describe('predicate discovery', () => {
  test('finds a column-left comparison with operator, relation and byte spans', () => {
    const sql = 'SELECT id FROM orders WHERE total_cents > 495000';
    const [site] = sitesOf(sql);
    assert.ok(site, 'expected a usable site');
    assert.equal(site.column, 'total_cents');
    assert.deepEqual(site.relation, ['orders']);
    assert.equal(site.operator, '>');
    assert.equal(site.literalText, '495000');
    const buf = Buffer.from(sql, 'utf8');
    assert.equal(
      buf.subarray(site.literalByteSpan.start, site.literalByteSpan.end).toString('utf8'),
      '495000',
    );
    assert.ok(site.location >= 0, 'A_Expr location is the pinnable coordinate');
  });

  test('finds the mirrored constant-left orientation', () => {
    const [site] = sitesOf('SELECT id FROM orders WHERE 495000 < total_cents');
    assert.ok(site);
    assert.equal(site.column, 'total_cents');
    assert.equal(site.operator, '<');
    assert.equal(site.literalText, '495000');
  });

  test('resolves an aliased qualifier to the base relation', () => {
    const [site] = sitesOf('SELECT o.id FROM orders o WHERE o.total_cents > 5');
    assert.ok(site);
    assert.deepEqual(site.relation, ['orders']);
    assert.equal(site.column, 'total_cents');
  });

  test('quoted string literals span their quotes', () => {
    const sql = "SELECT id FROM orders WHERE status = 'disputed'";
    const [site] = sitesOf(sql);
    assert.ok(site);
    assert.equal(site.literalText, "'disputed'");
  });

  test('multibyte text before the constant keeps byte and char spans distinct', () => {
    const sql = "SELECT id FROM orders WHERE note = 'café' AND total_cents > 495000";
    const site = sitesOf(sql).find((s) => s.column === 'total_cents');
    assert.ok(site);
    // é is two UTF-8 bytes, so the byte span sits one past the char span.
    assert.notEqual(site.literalByteSpan.start, site.charSpan.start);
    const buf = Buffer.from(sql, 'utf8');
    assert.equal(buf.subarray(site.literalByteSpan.start, site.literalByteSpan.end).toString('utf8'), '495000');
    assert.equal(sql.slice(site.charSpan.start, site.charSpan.end), '495000');
  });

  test('a function-wrapped column is kept with a skip reason, not dropped', () => {
    const skips = skipsOf("SELECT id FROM orders WHERE lower(status) = 'x'");
    assert.equal(skips.length, 1);
    assert.match(skips[0], /expression, not a plain column/);
    assert.match(skips[0], /pg_stats/);
  });

  test('a NULL literal is skipped with its reason', () => {
    const skips = skipsOf('SELECT id FROM orders WHERE note = NULL');
    assert.equal(skips.length, 1);
    assert.match(skips[0], /NULL/);
  });

  test('<> and LIKE are skipped as non-sweepable operators', () => {
    assert.match(skipsOf("SELECT id FROM orders WHERE status <> 'x'")[0], /`<>` is not a sweepable comparison/);
    assert.match(skipsOf("SELECT id FROM orders WHERE status LIKE 'a%'")[0], /`LIKE` is not a sweepable comparison/);
  });

  test("a predicate inside a sublink's scope is skipped — different FROM", () => {
    const found = discover(
      'SELECT id FROM orders WHERE id IN (SELECT order_id FROM order_items WHERE qty > 3)',
    );
    const qty = found.find((d) => d.candidate.column === 'qty');
    assert.ok(qty, 'the nested comparison is reported, not silently dropped');
    assert.match(qty.candidate.skipped ?? '', /nested subquery/);
    assert.equal(qty.site, null);
  });

  test('an ambiguous unqualified column over a two-table FROM refuses to guess', () => {
    const skips = skipsOf('SELECT * FROM orders, customers WHERE id > 5');
    assert.equal(skips.length, 1);
    assert.match(skips[0], /unqualified and this query reads 2 tables/);
  });

  test('a predicate under NOT is skipped in v1', () => {
    const skips = skipsOf('SELECT id FROM orders WHERE NOT (total_cents > 5)');
    assert.match(skips[0], /under NOT/);
  });

  test('a column-to-column comparison has no constant to vary', () => {
    const skips = skipsOf('SELECT * FROM orders o JOIN customers c ON true WHERE o.id = c.id');
    assert.match(skips[0], /two columns/);
  });

  test('a boolean constant is skipped — no spectrum to walk', () => {
    const skips = skipsOf('SELECT id FROM orders WHERE flag = true');
    assert.match(skips[0], /boolean/);
  });

  test('no WHERE clause discovers nothing', () => {
    assert.equal(discover('SELECT count(*) FROM orders').length, 0);
  });
});

describe('hasParamRef', () => {
  test('true for $1 anywhere in the tree', () => {
    assert.equal(hasParamRef(parseSync('SELECT id FROM orders WHERE id = $1')), true);
    assert.equal(
      hasParamRef(parseSync('SELECT id FROM orders WHERE id IN (SELECT order_id FROM order_items WHERE qty = $2)')),
      true,
    );
  });
  test('false without parameters', () => {
    assert.equal(hasParamRef(parseSync('SELECT id FROM orders WHERE id = 5')), false);
  });
});

// ── the anyarray round-trip, defensively ─────────────────────────────────────

describe('parseArrayLiteral (pg_stats anyarray text)', () => {
  test('plain numeric bounds', () => {
    assert.deepEqual(parseArrayLiteral('{49042,247118,448417}'), ['49042', '247118', '448417']);
  });
  test('negative numbers and exponents', () => {
    assert.deepEqual(parseArrayLiteral('{-5,-1.5,3e2}'), ['-5', '-1.5', '3e2']);
  });
  test('bare words', () => {
    assert.deepEqual(parseArrayLiteral('{complete,pending,refunded,disputed}'), [
      'complete', 'pending', 'refunded', 'disputed',
    ]);
  });
  test('timestamps are quoted because of the space, and unquote exactly', () => {
    assert.deepEqual(
      parseArrayLiteral('{"2025-08-04 14:40:36.173763","2026-01-08 14:40:36.173763"}'),
      ['2025-08-04 14:40:36.173763', '2026-01-08 14:40:36.173763'],
    );
  });
  test('quoted elements with commas, embedded double quotes, single quotes and backslashes', () => {
    assert.deepEqual(
      parseArrayLiteral('{"a,b","he said \\"hi\\"","O\'Brien","back\\\\slash"}'),
      ['a,b', 'he said "hi"', "O'Brien", 'back\\slash'],
    );
  });
  test('the empty array', () => {
    assert.deepEqual(parseArrayLiteral('{}'), []);
  });
  test('unquoted NULL is the SQL null; quoted "NULL" is the string', () => {
    assert.deepEqual(parseArrayLiteral('{a,NULL,b}'), ['a', null, 'b']);
    assert.deepEqual(parseArrayLiteral('{"NULL"}'), ['NULL']);
  });
  test('toTextArray passes driver-parsed arrays through and filters nulls', () => {
    assert.deepEqual(toTextArray(['a', 'b']), ['a', 'b']);
    assert.deepEqual(toTextArray('{a,NULL,b}'), ['a', 'b']);
    assert.equal(toTextArray(null), null);
  });
});

// ── stats interpretation ─────────────────────────────────────────────────────

const SITE: PredicateSite = {
  location: 28,
  column: 'total_cents',
  relation: ['orders'],
  relationKey: 'orders',
  operator: '>',
  literalText: '495000',
  literalByteSpan: { start: 42, end: 48 },
  charSpan: { start: 42, end: 48 },
};

const row = (over: Partial<StatsRow>): StatsRow => ({
  rel: 'orders',
  col: 'total_cents',
  rel_exists: true,
  relkind: 'r',
  reltuples: 400000,
  inherited: false,
  null_frac: 0,
  n_distinct: -1,
  most_common_vals: null,
  most_common_freqs: null,
  histogram_bounds: null,
  ...over,
});

describe('interpretStats', () => {
  test('prefers the inherited=false row and falls back to inherited=true', () => {
    const preferred = interpretStats(
      [SITE],
      [
        row({ inherited: false, histogram_bounds: ['1', '2', '3'] }),
        row({ inherited: true, histogram_bounds: ['9', '9', '9'] }),
      ],
    )[0];
    assert.deepEqual(preferred.histogram, ['1', '2', '3']);

    // A partitioned parent has only the inherited=true row.
    const fallback = interpretStats([SITE], [row({ inherited: true, histogram_bounds: ['7', '8'] })])[0];
    assert.deepEqual(fallback.histogram, ['7', '8']);
    assert.equal(fallback.basis, 'histogram');
  });

  test('a missing pg_stats row produces the ANALYZE evidence sentence', () => {
    const s = interpretStats([SITE], [row({ inherited: null, null_frac: null })])[0];
    assert.equal(s.basis, null);
    assert.match(s.evidence, /`pg_stats` has no row for `orders\.total_cents`/);
    assert.match(s.evidence, /ANALYZEd/);
  });

  test('a range operator with no histogram cites most_common_vals as the reason', () => {
    const s = interpretStats([SITE], [row({ most_common_vals: ['x'], most_common_freqs: [1] })])[0];
    assert.equal(s.basis, null);
    assert.match(s.evidence, /no histogram in `pg_stats`/);
    assert.match(s.evidence, /most_common_vals/);
  });

  test('an equality with no MCVs produces the n_distinct teaching refusal', () => {
    const eq: PredicateSite = { ...SITE, column: 'id', operator: '=', relationKey: 'orders', relation: ['orders'] };
    const s = interpretStats([eq], [row({ col: 'id', histogram_bounds: ['1', '2'] })])[0];
    assert.equal(s.basis, null);
    assert.match(s.evidence, /no most_common_vals/);
    assert.match(s.evidence, /n_distinct ≈ row count/);
    assert.match(s.evidence, /cannot flip the plan/);
  });

  test('a histogram basis cites pg_stats and the bucket count', () => {
    const s = interpretStats([SITE], [row({ histogram_bounds: Array.from({ length: 101 }, (_, i) => String(i)) })])[0];
    assert.equal(s.basis, 'histogram');
    assert.match(s.evidence, /101-bound histogram in `pg_stats`/);
    assert.match(s.evidence, /100 equal-frequency buckets/);
  });

  test('the probe pairs relations and columns positionally and dedupes', () => {
    const probe = buildStatsProbe([SITE, SITE, { ...SITE, column: 'id' }]);
    assert.deepEqual(probe.values, [['orders', 'orders'], ['total_cents', 'id']]);
    assert.match(probe.text, /pg_stats/);
    assert.match(probe.text, /::text::text\[\]/);
    assert.match(probe.text, /inherited ASC NULLS LAST/);
  });
});

// ── choice ───────────────────────────────────────────────────────────────────

describe('chooseSite', () => {
  const orders = { site: SITE, stats: stats({ reltuples: 400000 }) };
  const items = {
    site: { ...SITE, column: 'qty', relation: ['order_items'], relationKey: 'order_items', location: 60 },
    stats: stats({ reltuples: 800000 }),
  };

  test('picks the larger reltuples relation and cites pg_class.reltuples', () => {
    const { index, why } = chooseSite([orders, items]);
    assert.equal(index, 1);
    assert.match(why, /`order_items` holds ~800\.0K rows/);
    assert.match(why, /pg_class\.reltuples/);
  });

  test('ties break to the earliest location', () => {
    const early = { ...orders, site: { ...SITE, location: 10 } };
    const late = { ...orders, site: { ...SITE, location: 50 } };
    assert.equal(chooseSite([late, early]).index, 1);
  });
});

// ── variants ─────────────────────────────────────────────────────────────────

const RANGE_SQL = 'SELECT id FROM orders WHERE total_cents > 495000';
const rangeSite = (): PredicateSite => sitesOf(RANGE_SQL)[0];

describe('buildVariants — histogram positions', () => {
  test('101 bounds select indices 10/50/90 with the p-labels', () => {
    const hist = Array.from({ length: 101 }, (_, i) => String(i * 1000));
    const build = buildVariants(RANGE_SQL, rangeSite(), stats({ histogram: hist }));
    assert.ok(build.ok);
    assert.deepEqual(build.variants.map((v) => v.label), ['p10', 'p50', 'p90']);
    assert.deepEqual(build.variants.map((v) => v.value), ['10000', '50000', '90000']);
    assert.equal(build.variants[0].frequency, null);
  });

  test('3 bounds clamp to the ends and the middle', () => {
    const build = buildVariants(RANGE_SQL, rangeSite(), stats({ histogram: ['1', '2', '3'] }));
    assert.ok(build.ok);
    assert.deepEqual(build.variants.map((v) => v.value), ['1', '2', '3']);
  });

  test('1 bound refuses with the too-small sentence', () => {
    const build = buildVariants(RANGE_SQL, rangeSite(), stats({ histogram: ['1'] }));
    assert.equal(build.ok, false);
    assert.match((build as { refusal: string }).refusal, /too small to sweep/);
  });

  test('textual dedupe drops equal p-points and can refuse', () => {
    const build = buildVariants(RANGE_SQL, rangeSite(), stats({ histogram: ['5', '5', '5'] }));
    assert.equal(build.ok, false);
    assert.match((build as { refusal: string }).refusal, /only 1 distinct bound/);
  });
});

const EQ_SQL = "SELECT id FROM orders WHERE status = 'disputed'";
const eqSite = (): PredicateSite => sitesOf(EQ_SQL)[0];

describe('buildVariants — equality', () => {
  test('first and last MCV with frequencies, plus a middle histogram bound', () => {
    const build = buildVariants(
      EQ_SQL,
      eqSite(),
      stats({ mcv: ['complete', 'pending', 'refunded', 'disputed'], mcvFreqs: [0.9694, 0.0207, 0.0082, 0.0016], histogram: ['a', 'b', 'c', 'd', 'e'] }),
    );
    assert.ok(build.ok);
    assert.deepEqual(build.variants.map((v) => v.label), ['most common', 'least common MCV', 'outside the MCV list']);
    assert.deepEqual(build.variants.map((v) => v.value), ['complete', 'disputed', 'c']);
    assert.equal(build.variants[0].frequency, 0.9694);
    assert.equal(build.variants[1].frequency, 0.0016);
    assert.equal(build.variants[2].frequency, null);
  });

  test('an all-MCV column (no histogram) yields two variants and the no-rarer-value sentence', () => {
    const build = buildVariants(
      EQ_SQL,
      eqSite(),
      stats({ mcv: ['complete', 'pending', 'refunded', 'disputed'], mcvFreqs: [0.97, 0.02, 0.008, 0.002] }),
    );
    assert.ok(build.ok);
    assert.equal(build.variants.length, 2);
    assert.match(build.notes[0], /no rarer value exists to test/);
  });

  test('a single MCV with no histogram cannot show a boundary', () => {
    const build = buildVariants(EQ_SQL, eqSite(), stats({ mcv: ['only'], mcvFreqs: [1] }));
    assert.equal(build.ok, false);
    assert.match((build as { refusal: string }).refusal, /at least two points/);
  });
});

describe('literal formatting and the byte-domain splice', () => {
  test("O'Brien doubles its quote and the variant admits and parses", () => {
    const sql = "SELECT id FROM customers WHERE email = 'x'";
    const [site] = sitesOf(sql);
    const build = buildVariants(sql, site, stats({
      mcv: ["O'Brien", 'plain'], mcvFreqs: [0.5, 0.4],
    }));
    assert.ok(build.ok);
    const obrien = build.variants.find((v) => v.value === "O'Brien");
    assert.ok(obrien);
    assert.equal(obrien.literal, "'O''Brien'");
    assert.ok(obrien.sql.includes("email = 'O''Brien'"), obrien.sql);
    assert.equal(admitQuery(obrien.sql).ok, true);
    assert.doesNotThrow(() => parseSync(obrien.sql));
  });

  test('a multibyte character before the constant still splices at the right bytes', () => {
    const sql = "SELECT id FROM orders WHERE note = 'café' AND total_cents > 495000";
    const site = sitesOf(sql).find((s) => s.column === 'total_cents')!;
    const build = buildVariants(sql, site, stats({ histogram: ['100', '200', '300'] }));
    assert.ok(build.ok);
    for (const v of build.variants) {
      assert.ok(v.sql.includes("note = 'café'"), `é corrupted by the splice: ${v.sql}`);
      assert.ok(v.sql.includes(`total_cents > '${v.value}'`), v.sql);
    }
  });

  test('a timestamp value splices as one quoted literal', () => {
    const sql = "SELECT * FROM promotions WHERE applied_at > '2025-01-01'";
    const [site] = sitesOf(sql);
    const build = buildVariants(sql, site, stats({
      histogram: ['2025-08-04 14:40:36.173763', '2026-01-08 14:40:36.173763', '2026-06-19 14:40:36.173763'],
    }));
    assert.ok(build.ok);
    assert.ok(build.variants[0].sql.includes("applied_at > '2025-08-04 14:40:36.173763'"));
  });

  test('validateConstSplice accepts a correct splice and the identical-text case', () => {
    const sql = "SELECT id FROM orders WHERE status = 'disputed'";
    const variant = sql.replace("'disputed'", "'complete'");
    assert.equal(validateConstSplice(sql, variant, "'complete'"), null);
    assert.equal(validateConstSplice(sql, sql, "'disputed'"), null);
  });

  test('validateConstSplice rejects a corrupted splice', () => {
    const sql = 'SELECT id FROM orders WHERE total_cents > 495000';
    // The claimed literal and the actual edit disagree — a scanner bug shape.
    const corrupted = sql.replace('total_cents > 495000', "total_cents > '1' OR true");
    const problem = validateConstSplice(sql, corrupted, "'1'");
    assert.ok(problem !== null, 'a splice that changed more than the constant must be withheld');
  });

  test('buildVariants withholds a variant whose splice fails validation — it refuses, never emits it as valid', () => {
    // The gap this closes: validateConstSplice is unit-tested on its own just
    // above, but buildVariants' USE of it — withhold the bad splice WITH a note,
    // then continue past it — was never exercised. Here we drive that defense
    // with the exact defect it guards against: a bad byte offset (a scanner
    // bug), forced by shrinking the site's literal span by one byte so every
    // generated splice lands mid-token and reparses wrong. quoteLiteral makes
    // the outcome value-independent, so all three picks hit the withhold branch
    // (each recorded with its `was withheld: …` note and skipped); with none
    // left standing, buildVariants surfaces its own-bug refusal rather than
    // shipping a corrupted variant as if it were valid evidence.
    const site = rangeSite();
    const badOffset: PredicateSite = {
      ...site,
      literalByteSpan: { start: site.literalByteSpan.start, end: site.literalByteSpan.end - 1 },
    };
    const build = buildVariants(RANGE_SQL, badOffset, stats({ histogram: ['100000', '200000', '300000'] }));
    // ok:false is itself the proof that no corrupted variant was emitted — the
    // ok:true shape is the only one that carries a variants array.
    assert.equal(build.ok, false, 'a build carrying a corrupted variant must never report ok');
    const refusal = (build as { refusal: string }).refusal;
    // The post-withhold refusal, reached only after the loop discarded every
    // corrupted splice — and worded as the agent's own bug, not the user's.
    assert.match(refusal, /reparse validation/);
    assert.match(refusal, /agent bug/);
    assert.match(refusal, /not a property of your query/);
  });

  test('quoteLiteral doubles every quote', () => {
    assert.equal(quoteLiteral("a'b'c"), "'a''b''c'");
  });
});

// ── signatures and flips ─────────────────────────────────────────────────────

describe('accessSignature', () => {
  test('matches the history.ts label format on a real captured plan', () => {
    const sig = accessSignature(fixturePlan('join-agg.json'));
    // Pre-order: the join operator, then its outer child, then the hashed inner.
    assert.deepEqual(sig, ['Hash Join', 'Seq Scan on orders', 'Seq Scan on customers']);
  });

  test('an index scan carries its index via-label', () => {
    const sig = accessSignature(fixturePlan('whatif-after.json'));
    assert.deepEqual(sig, ['Index Scan on orders via <13605>btree_orders_status_created_at']);
  });
});

describe('findFlips', () => {
  const idx = ['Index Scan on orders via orders_pkey'];
  const seq = ['Seq Scan on orders'];
  // estimatedRows is the ROOT output; scanRows is the swept relation's own scan
  // estimate. They are set apart here on purpose — as on a `count(*)` query,
  // where the root is 1 at every point while the orders scan swings wide — so
  // the headline is forced to cite the scan figure, never the misleading root 1.
  const points: FlipPoint[] = [
    { label: 'p10', value: '39116', signature: idx, totalCost: 1758, estimatedRows: 1, scanRows: 39999 },
    { label: 'p50', value: '201178', signature: idx, totalCost: 8774, estimatedRows: 1, scanRows: 199999 },
    { label: 'p90', value: '359773', signature: seq, totalCost: 11142, estimatedRows: 1, scanRows: 359999 },
  ];
  const site = { column: 'id', operator: '<', relation: ['orders'] };

  test('brackets the boundary with both values, both costs, and the swept relation row estimates', () => {
    const flips = findFlips(points, site);
    assert.equal(flips.length, 1);
    const flip = flips[0];
    assert.equal(flip.fromLabel, 'p50');
    assert.equal(flip.toLabel, 'p90');
    assert.equal(flip.fromValue, '201178');
    assert.equal(flip.toValue, '359773');
    assert.deepEqual(flip.before, idx);
    assert.deepEqual(flip.after, seq);
    assert.match(flip.headline, /→/);
    assert.match(flip.headline, /estimates, not measurements/);
    assert.match(flip.headline, /8774/);
    assert.match(flip.headline, /11142/);
    assert.match(flip.headline, /Index Scan on orders via orders_pkey → Seq Scan on orders/);
    // The bracket ends cite the swept relation's scan estimates (~200.0K →
    // ~360.0K), pinned to `orders`, NOT the root output (1). This is finding
    // #1's fix at the flip-headline level: the rows moved across the flip, and
    // the headline must say so rather than print an identical "~1 rows" twice.
    assert.match(flip.headline, /~200\.0K rows on `orders`/);
    assert.match(flip.headline, /~360\.0K rows on `orders`/);
    assert.doesNotMatch(flip.headline, /~1 rows/);
  });

  test('identical signatures produce no flip', () => {
    const flat = points.map((p) => ({ ...p, signature: seq }));
    assert.equal(findFlips(flat, site).length, 0);
  });

  test('a point with no identifiable scan on the relation is bracketed without a row figure', () => {
    // scanRows null (the swept relation was folded into a join, scanned twice by
    // a self-join, etc.): the bracket ends must name the plan shapes only, never
    // fall back to pairing the root output against the relation's cardinality.
    const noScan: FlipPoint[] = [
      { ...points[0], scanRows: null },
      { ...points[2], scanRows: null },
    ];
    const flip = findFlips(noScan, site)[0];
    assert.ok(flip, 'the signatures still differ, so there is still a flip');
    assert.doesNotMatch(flip.headline, /rows on `orders`/);
    assert.doesNotMatch(flip.headline, /~1 rows/);
    assert.match(flip.headline, /the plan flips/);
  });
});
