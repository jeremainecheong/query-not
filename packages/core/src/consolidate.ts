/**
 * Workload-level index consolidation — the pure half.
 *
 * A per-query advisor answers "what index helps this statement". This module
 * answers the question that actually decides what gets built: "what is the
 * smallest set of indexes that serves the workload". Ten statements often
 * imply three indexes, because equality sets that form prefix chains share one
 * composite index — that is the whole reason composite indexes exist.
 *
 * Everything here is deterministic and engine-neutral: demands go in, a merged
 * candidate set comes out, and every claim is checked structurally by
 * `serves()` before anyone re-plans anything. The agent then proves each
 * candidate against every query with a hypothetical index — a wrong merge is
 * allowed to exist here precisely because it cannot survive the proof.
 *
 * Relation names are the plan's unqualified `Relation Name`, resolved by the
 * session's search_path — the same existing limitation as suggestIndexes'
 * DDL. Two identically named tables in different schemas would collide in the
 * merge, but their per-query proofs still run through the session's own
 * search_path, so a wrong merge cannot prove.
 */

import { extractColumns, orderForIndex, quoteIdent } from './predicates.ts';
import type { QueryPlan } from './types.ts';

/** A column the merge refused to claim, and the reason it refused. */
export interface DroppedColumn {
  name: string;
  reason: string;
}

/** What one scan node asks of an index: an equality prefix, at most one range. */
export interface IndexDemand {
  relation: string;
  nodeId: string;
  /** Equality (and membership) columns, in extraction order. */
  equality: string[];
  /** At most one range column — only the leading range column bounds a scan. */
  range: string | null;
  /** Columns a consolidated plain b-tree cannot honestly serve. */
  dropped: DroppedColumn[];
}

/** A demand carrying the queries (and their workload weight) that produced it. */
export interface WeightedDemand {
  relation: string;
  equality: string[];
  range: string | null;
  queries: Array<{ fingerprint: string; weight: number }>;
}

export interface ConsolidatedIndex {
  relation: string;
  columns: string[];
  /** Parallel to `columns`: 'eq' for prefix members, 'range' for the trailing bound. */
  roles: Array<'eq' | 'range'>;
  ddl: string;
  rationale: string;
  /** Sum of the distinct claimed queries' workload shares. */
  weight: number;
  /** Fingerprints of every demand this index structurally serves. */
  claims: string[];
  /** Narrower per-query indexes this one would make redundant. */
  replaces: Array<{ relation: string; columns: string[] }>;
}

export interface ConsolidationResult {
  candidates: ConsolidatedIndex[];
  /** Single-query, single-demand groups — the per-query advisor's job, not ours. */
  standalone: Array<{ relation: string; columns: string[]; fingerprints: string[] }>;
  /** Candidates beyond maxCandidates — dropped from proving, never silently. */
  omitted: Array<{ relation: string; columns: string[]; weight: number }>;
}

export interface DemandExtractionOptions {
  /**
   * Fraction of a node's rows a filter must discard before a demand exists.
   * Matches analyze()'s default so the demand gate and suggestIndexes' gate
   * cannot drift apart.
   */
  filterWasteFraction?: number;
}

export interface ConsolidateOptions {
  /** Candidates kept for proving. Overflow is reported, never silently cut. */
  maxCandidates?: number;
  /**
   * Widest index a merge may produce. Past five columns, one wide index is
   * worse advice than two narrower ones — width costs every write and every
   * cache line, and the sixth column serves almost nothing.
   */
  maxColumns?: number;
}

/**
 * Extract index demands from a plan, one per qualifying scan node.
 *
 * The gating mirrors suggestIndexes exactly — same node types, same predicate
 * source, same selectivity test — so a demand exists precisely where the
 * per-query advisor would have suggested an index. The difference is the
 * output: not DDL, but the *shape* the scan needs (equality set + one range),
 * which is what the merge algorithm can reason about.
 */
export function extractIndexDemands(
  plan: QueryPlan,
  options: DemandExtractionOptions = {},
): IndexDemand[] {
  const filterWasteFraction = options.filterWasteFraction ?? 0.9;
  const out: IndexDemand[] = [];

  for (const node of plan.nodes) {
    if (node.neverExecuted || !node.relation) continue;
    if (node.nodeType !== 'Seq Scan' && node.nodeType !== 'Bitmap Heap Scan') continue;

    const predicate = node.filter ?? node.recheckCond;
    if (!predicate) continue;

    // Rows Removed by Filter is reported per loop, like everything else.
    const removedPerLoop = node.rowsRemovedByFilter;
    const removed = removedPerLoop === null ? 0 : removedPerLoop * (node.loops ?? 1);
    const kept = node.actualRowsTotal ?? 0;

    // On an un-analyzed plan there is no measured selectivity; fall back to
    // the estimate, exactly as suggestIndexes does.
    const selective = plan.analyzed
      ? removed + kept > 0 && removed / (removed + kept) >= filterWasteFraction && removed >= 1000
      : node.planRows < node.totalCost;
    if (!selective) continue;

    const equality: string[] = [];
    let range: string | null = null;
    const dropped: DroppedColumn[] = [];

    for (const col of orderForIndex(extractColumns(predicate))) {
      // A consolidated b-tree serves plain column references only. Wrapped and
      // pattern columns are dropped with the reason on record — claiming them
      // would be a lie the proof step could not even detect, because the index
      // might still help via its other columns.
      if (col.wrappedIn !== null) {
        dropped.push({
          name: col.name,
          reason:
            `\`${col.wrappedIn}(${col.name})\` — a plain b-tree on the column cannot serve a ` +
            'function-wrapped predicate; see the per-query suggestion for the expression-index route.',
        });
        continue;
      }
      if (col.op === 'pattern') {
        dropped.push({
          name: col.name,
          reason:
            `\`${col.name}\` is matched with a pattern operator, which a consolidated plain b-tree ` +
            'cannot claim to serve; the per-query advisor covers the operator-class and trigram routes.',
        });
        continue;
      }
      if (col.op === 'eq' || col.op === 'membership') {
        equality.push(col.name);
      } else if (col.op === 'range' && range === null) {
        // orderForIndex already keeps a single range column; the guard is
        // belt-and-braces against a future change there.
        range = col.name;
      }
    }

    // A node whose usable columns all dropped produces no demand — there is
    // nothing an index of ours could honestly do for it.
    if (equality.length === 0 && range === null) continue;

    out.push({ relation: node.relation, nodeId: node.id, equality, range, dropped });
  }

  return out;
}

/**
 * Whether an ordered column list fully serves a demand.
 *
 * Full service only: the demand's equality set must be exactly the index's
 * leading prefix (any order — the planner does not care about order within an
 * equality prefix), and the range column, if any, must sit immediately after
 * it, because a b-tree uses one range boundary and only right after the
 * equality prefix. Trailing extra columns cost width, not usability, so they
 * do not defeat service. There are no partial-service claims.
 */
export function serves(
  columns: string[],
  demand: { equality: string[]; range: string | null },
): boolean {
  const k = demand.equality.length;
  if (columns.length < k) return false;
  const prefix = new Set(columns.slice(0, k));
  // Both sets have k members iff prefix has no duplicates; containment of all
  // k equality columns then makes them equal.
  if (prefix.size !== k) return false;
  for (const col of demand.equality) {
    if (!prefix.has(col)) return false;
  }
  if (demand.range !== null && columns[k] !== demand.range) return false;
  return true;
}

/** A demand after dedupe, with its distinct queries and summed weight. */
interface MergedDemand {
  key: string;
  relation: string;
  /** Extraction order of the first-seen instance — used for `replaces`. */
  equality: string[];
  eqSet: Set<string>;
  range: string | null;
  queries: Map<string, number>;
  weight: number;
}

interface Layout {
  columns: string[];
  roles: Array<'eq' | 'range'>;
}

function setEquals(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Order a set of demands into one column list, or fail.
 *
 * The structural condition for one index to serve every demand is that the
 * equality sets form a ⊆-chain — then each set is a prefix of the union — and
 * that every demanded range column can sit immediately after its demand's
 * prefix. Anything else fails, and failure is cheap: the demand simply opens
 * its own group.
 */
function layoutDemands(members: MergedDemand[], maxColumns: number): Layout | null {
  // (a) Ascending by equality size. Two demands of equal size must have equal
  // sets — two different same-size sets cannot both be a prefix of one order.
  const sorted = [...members].sort((a, b) => a.eqSet.size - b.eqSet.size);
  const chain: Set<string>[] = [];
  for (const m of sorted) {
    const last = chain[chain.length - 1];
    if (last && last.size === m.eqSet.size) {
      if (!setEquals(last, m.eqSet)) return null;
      continue;
    }
    // (b) Each consecutive distinct pair must satisfy eqᵢ ⊆ eqᵢ₊₁; with (a)
    // this makes the whole set a ⊆-chain.
    if (last) {
      for (const col of last) if (!m.eqSet.has(col)) return null;
    }
    chain.push(m.eqSet);
  }

  // (c) Equality blocks: the columns each chain step introduces.
  const blocks: string[][] = [];
  const blockStart: number[] = [];
  const covered = new Set<string>();
  for (const eqSet of chain) {
    const fresh = [...eqSet].filter((c) => !covered.has(c));
    if (fresh.length === 0) continue;
    blockStart.push(covered.size);
    blocks.push(fresh);
    for (const c of fresh) covered.add(c);
  }
  const unionSize = covered.size;

  // (d) Range pinning. A demand's range column must sit at position |eq| —
  // either pinned first inside the next block, or as the single trailing
  // range column.
  let trailing: string | null = null;
  const pinAt = new Map<number, string>();
  for (const m of members) {
    if (m.range === null) continue;
    if (m.eqSet.size === unionSize) {
      if (trailing !== null && trailing !== m.range) return null;
      trailing = m.range;
    } else {
      const position = m.eqSet.size;
      const blockIndex = blockStart.indexOf(position);
      if (blockIndex === -1) return null;
      const block = blocks[blockIndex] as string[];
      if (!block.includes(m.range)) return null;
      const existing = pinAt.get(position);
      if (existing !== undefined && existing !== m.range) return null;
      pinAt.set(position, m.range);
    }
  }

  // Within a block, no in-scope query distinguishes the order — several
  // columns entered at the same chain step — so the column more of the
  // workload filters on leads: it best serves future subset queries.
  // Alphabetical closes the tie deterministically.
  const colWeight = (col: string): number =>
    members.reduce((sum, m) => sum + (m.eqSet.has(col) ? m.weight : 0), 0);

  const columns: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const pin = pinAt.get(blockStart[i] as number);
    const rest = (blocks[i] as string[])
      .filter((c) => c !== pin)
      .sort((a, b) => colWeight(b) - colWeight(a) || compareStrings(a, b));
    if (pin !== undefined) columns.push(pin);
    columns.push(...rest);
  }
  const roles: Array<'eq' | 'range'> = columns.map(() => 'eq');
  if (trailing !== null) {
    columns.push(trailing);
    roles.push('range');
  }

  if (columns.length > maxColumns) return null;

  // (e) Defensive check: claims must be sound by construction, not by hope.
  for (const m of members) {
    if (!serves(columns, m)) return null;
  }

  return { columns, roles };
}

/** The per-query advisor's column order for one demand: equality then range. */
function perQueryColumns(demand: MergedDemand): string[] {
  return demand.range === null ? [...demand.equality] : [...demand.equality, demand.range];
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function rationaleFor(layout: Layout, demandCount: number, statementCount: number): string {
  const merged = `Merged from ${plural(demandCount, 'predicate shape')} across ${plural(statementCount, 'statement')}.`;
  if (layout.columns.length === 1) {
    return `A single-column index on \`${layout.columns[0]}\`. ${merged}`;
  }
  const listed = layout.columns.map((c) => `\`${c}\``).join(', then ');
  return (
    `Columns ordered equality-first — ${listed} — which is what lets a composite index use more ` +
    `than its leading column; a query filtering \`${layout.columns[0]}\` alone uses the same ` +
    `index's prefix. ${merged}`
  );
}

/**
 * Merge weighted demands into a small candidate set.
 *
 * Deterministic from end to end: dedupe, seed order by weight, greedy
 * first-fit grouping per relation, then a claim sweep that is independent of
 * grouping accidents — a demand shut out of a group by the width cap is still
 * claimed by any candidate that serves it.
 */
export function consolidateDemands(
  demands: WeightedDemand[],
  options: ConsolidateOptions = {},
): ConsolidationResult {
  const maxCandidates = options.maxCandidates ?? 5;
  const maxColumns = options.maxColumns ?? 5;

  // Step 0 — dedupe by shape. A fingerprint counts once per shape, so a query
  // hitting the same predicate twice cannot inflate the shape's weight.
  const merged = new Map<string, MergedDemand>();
  for (const d of demands) {
    const key = `${d.relation}|${[...d.equality].sort().join(',')}|${d.range ?? ''}`;
    let m = merged.get(key);
    if (!m) {
      m = {
        key,
        relation: d.relation,
        equality: [...d.equality],
        eqSet: new Set(d.equality),
        range: d.range,
        queries: new Map(),
        weight: 0,
      };
      merged.set(key, m);
    }
    for (const q of d.queries) {
      if (!m.queries.has(q.fingerprint)) m.queries.set(q.fingerprint, q.weight);
    }
  }
  const all = [...merged.values()];
  for (const m of all) {
    m.weight = [...m.queries.values()].reduce((sum, w) => sum + w, 0);
  }

  // Step 1 — seed order: weight, then wider equality sets (they anchor the
  // chain), then key for full determinism.
  const seed = [...all].sort(
    (a, b) =>
      b.weight - a.weight || b.eqSet.size - a.eqSet.size || compareStrings(a.key, b.key),
  );

  // Step 2 — greedy first-fit, per relation only.
  interface Group {
    relation: string;
    members: MergedDemand[];
    layout: Layout;
  }
  const groups: Group[] = [];
  for (const demand of seed) {
    let placed = false;
    for (const group of groups) {
      if (group.relation !== demand.relation) continue;
      const attempt = layoutDemands([...group.members, demand], maxColumns);
      if (attempt) {
        group.members.push(demand);
        group.layout = attempt;
        placed = true;
        break;
      }
    }
    if (placed) continue;
    // A new group always forms: the width cap gates merging, not a single
    // demand's own shape — refusing to represent a demand at all would lose a
    // legitimate claim silently.
    const alone = layoutDemands([demand], Number.POSITIVE_INFINITY);
    // A single demand always lays out (trivial chain, one range at most).
    if (alone) groups.push({ relation: demand.relation, members: [demand], layout: alone });
  }

  // Steps 4–5 — claim sweep, then emit. Claims come from serves() over every
  // demand, not from group membership, so grouping accidents cannot narrow
  // what a candidate honestly covers.
  const candidates: ConsolidatedIndex[] = [];
  const standalone: ConsolidationResult['standalone'] = [];
  for (const group of groups) {
    const claimed = all.filter(
      (d) => d.relation === group.relation && serves(group.layout.columns, d),
    );
    const queryWeights = new Map<string, number>();
    for (const d of claimed) {
      for (const [fp, w] of d.queries) {
        if (!queryWeights.has(fp)) queryWeights.set(fp, w);
      }
    }
    const claims = [...queryWeights.keys()];

    if (claims.length < 2 && claimed.length < 2) {
      standalone.push({
        relation: group.relation,
        columns: group.layout.columns,
        fingerprints: claims,
      });
      continue;
    }

    const replaces: Array<{ relation: string; columns: string[] }> = [];
    const seenReplace = new Set<string>();
    for (const d of claimed) {
      const cols = perQueryColumns(d);
      if (cols.join(',') === group.layout.columns.join(',')) continue;
      const replaceKey = `${d.relation}(${cols.join(',')})`;
      if (seenReplace.has(replaceKey)) continue;
      seenReplace.add(replaceKey);
      replaces.push({ relation: d.relation, columns: cols });
    }

    const names = group.layout.columns.map(quoteIdent);
    candidates.push({
      relation: group.relation,
      columns: group.layout.columns,
      roles: group.layout.roles,
      // CONCURRENTLY is for the human who builds it; the proof step strips it,
      // exactly as the per-query suggestions do.
      ddl: `CREATE INDEX CONCURRENTLY ON ${quoteIdent(group.relation)} (${names.join(', ')});`,
      rationale: rationaleFor(group.layout, claimed.length, claims.length),
      weight: [...queryWeights.values()].reduce((sum, w) => sum + w, 0),
      claims,
      replaces,
    });
  }

  candidates.sort(
    (a, b) =>
      b.weight - a.weight || a.columns.length - b.columns.length || compareStrings(a.ddl, b.ddl),
  );

  const kept = candidates.slice(0, maxCandidates);
  const omitted = candidates
    .slice(maxCandidates)
    .map((c) => ({ relation: c.relation, columns: c.columns, weight: c.weight }));

  return { candidates: kept, standalone, omitted };
}
