/**
 * Teaching mode.
 *
 * Deterministic narration — templates over the IR, no model in the loop. This
 * is a deliberate constraint from REQUIREMENTS.md F2: narration, never
 * judgement. A generated sentence describing what a Hash Join is cannot be
 * wrong in a way that costs someone a production index. A generated sentence
 * recommending one can.
 *
 * Judgement lives in analyze.ts (measured) and the what-if engine (proven).
 */

import { describeNode } from './parse.ts';
import { formatMs, formatPercent, formatRatio, formatRows } from './format.ts';
import type { PlanNode, QueryPlan } from './types.ts';

interface NodeExplanation {
  /** What this operation does, in one sentence. */
  what: string;
  /** When the planner chooses it. */
  why: string;
  /** The failure mode to watch for. */
  watch: string | null;
}

const GLOSSARY: Record<string, NodeExplanation> = {
  'Seq Scan': {
    what: 'Reads every row in the table, start to finish.',
    why: 'Chosen when no useful index exists, or when the planner expects to match so much of the table that scanning it in physical order beats jumping around an index.',
    watch: 'A sequential scan that returns a small fraction of what it reads is doing avoidable work — that is the classic missing-index shape.',
  },
  'Index Scan': {
    what: 'Walks an index to find matching rows, then fetches each one from the table.',
    why: 'Chosen when the planner expects few enough matches that the per-row heap fetch is cheaper than reading the whole table.',
    watch: 'Each match costs a random heap read. If the planner underestimated the match count, this can end up slower than a sequential scan.',
  },
  'Index Only Scan': {
    what: 'Answers entirely from the index, never touching the table.',
    why: 'Possible when every column the query needs is present in the index and the visibility map says the pages are all-visible.',
    watch: 'Heap Fetches above zero means the visibility map was stale and it had to touch the table anyway — a vacuum problem.',
  },
  'Bitmap Heap Scan': {
    what: 'Builds a bitmap of matching row locations from an index, then reads the table in physical order.',
    why: 'A middle ground: too many matches for row-at-a-time index lookups, too few to justify reading everything. Sorting the reads makes them sequential rather than random.',
    watch: 'If the bitmap outgrows work_mem it degrades to tracking whole pages, forcing a recheck of every row on them.',
  },
  'Bitmap Index Scan': {
    what: 'Scans the index to build the bitmap the Bitmap Heap Scan above it will use.',
    why: 'Always paired with a Bitmap Heap Scan.',
    watch: null,
  },
  'Nested Loop': {
    what: 'For every row from the outer side, scans the inner side for matches.',
    why: 'Cheapest join when the outer side yields very few rows, because it has no setup cost at all.',
    watch: 'Cost scales with outer rows multiplied by inner cost. A handful of outer rows is fine; an underestimate that turns ten into ten thousand is how a fast query becomes a timeout.',
  },
  'Hash Join': {
    what: 'Builds a hash table from one side, then probes it with rows from the other.',
    why: 'Chosen for equality joins on larger inputs — building the table costs upfront, but each probe is then near-constant time.',
    watch: 'The hash table must fit in work_mem. If it does not, the join splits into batches and each batch means another pass over the data.',
  },
  'Merge Join': {
    what: 'Walks two sorted inputs in step, matching as it goes.',
    why: 'Efficient when both inputs are already sorted on the join key, often because indexes provided the order for free.',
    watch: 'If the inputs are not already sorted, the sorts required to enable this can cost more than a hash join would have.',
  },
  Hash: {
    what: 'Builds the hash table that the Hash Join above it probes.',
    why: 'Always paired with a Hash Join.',
    watch: 'Its memory use is what decides whether the join spills to batches.',
  },
  Sort: {
    what: 'Orders rows.',
    why: 'Required by ORDER BY, and by merge joins and some aggregates that need sorted input.',
    watch: 'A sort that exceeds work_mem spills to disk, which is dramatically slower. An index providing the order can remove the sort entirely.',
  },
  Aggregate: {
    what: 'Reduces many rows to a summary — count, sum, avg and friends.',
    why: 'Required by aggregate functions without GROUP BY, or over already-grouped input.',
    watch: null,
  },
  HashAggregate: {
    what: 'Groups rows using a hash table keyed on the grouping columns.',
    why: 'The usual choice for GROUP BY when the input is not already sorted.',
    watch: 'Like a hash join, it needs the group keys to fit in work_mem, and spills if they do not.',
  },
  GroupAggregate: {
    what: 'Groups rows arriving in sorted order, emitting each group as it ends.',
    why: 'Chosen when the input is already sorted on the grouping key, which makes grouping nearly free.',
    watch: null,
  },
  Limit: {
    what: 'Stops after the requested number of rows.',
    why: 'LIMIT — and it can stop the nodes beneath it early too.',
    watch: 'A LIMIT with a large OFFSET still has to produce and discard every skipped row. Keyset pagination avoids that.',
  },
  Gather: {
    what: 'Collects rows from parallel workers back into a single stream.',
    why: 'The boundary where a parallel plan becomes serial again.',
    watch: 'If fewer workers launch than were planned, the plan was costed for parallelism it never got.',
  },
  'Gather Merge': {
    what: 'Collects rows from parallel workers while preserving their sort order.',
    why: 'Used when a parallel plan must stay ordered.',
    watch: null,
  },
  Materialize: {
    what: 'Caches its input so the node above can re-read it without recomputing.',
    why: 'Usually inserted on the inner side of a nested loop, so repeated scans hit the cache instead of the table.',
    watch: null,
  },
  Memoize: {
    what: 'Caches inner-side results keyed by the join parameters, reusing them across loop iterations.',
    why: 'Added when the planner expects the same lookup to repeat within a nested loop.',
    watch: 'Only pays off when the outer side has repeating values. Check the hit rate.',
  },
  'CTE Scan': {
    what: 'Reads the materialised result of a WITH clause.',
    why: 'Chosen when the CTE was materialised rather than inlined.',
    watch: 'A materialised CTE is an optimisation fence — predicates from the outer query cannot be pushed into it. MATERIALIZED and NOT MATERIALIZED let you control this explicitly.',
  },
  'Subquery Scan': {
    what: 'Reads the output of a subquery that could not be flattened into the parent.',
    why: 'Appears when a subquery has to be evaluated on its own terms.',
    watch: null,
  },
  Append: {
    what: 'Concatenates the output of several child plans.',
    why: 'UNION ALL, and scanning multiple partitions.',
    watch: 'On a partitioned table, a large child count can mean partition pruning did not happen.',
  },
  Unique: {
    what: 'Removes adjacent duplicate rows from sorted input.',
    why: 'DISTINCT or UNION over already-sorted rows.',
    watch: null,
  },
  'Function Scan': {
    what: 'Reads rows returned by a set-returning function.',
    why: 'A function appears in the FROM clause.',
    watch: 'The planner has almost no idea how many rows a function will return — it guesses 1000 by default. ROWS on the function definition improves that.',
  },
  Result: {
    what: 'Evaluates an expression without reading a table.',
    why: 'A constant or computed row, or a one-time filter that turned out to be false.',
    watch: null,
  },
};

const FALLBACK: NodeExplanation = {
  what: 'Processes rows from its children.',
  why: 'Chosen by the planner as part of the overall strategy.',
  watch: null,
};

export function explainNodeType(nodeType: string): NodeExplanation {
  if (GLOSSARY[nodeType]) return GLOSSARY[nodeType] as NodeExplanation;
  // Strip qualifiers Postgres prefixes on: "Parallel Seq Scan", "Partial HashAggregate".
  const stripped = nodeType
    .replace(/^(Parallel|Partial|Finalize)\s+/g, '')
    .trim();
  return (GLOSSARY[stripped] as NodeExplanation | undefined) ?? FALLBACK;
}

/** A sentence or two describing what this specific node did, with its numbers. */
export function narrateNode(node: PlanNode, plan: QueryPlan): string {
  const explanation = explainNodeType(node.nodeType);
  const sentences: string[] = [explanation.what];

  if (node.neverExecuted) {
    sentences.push('This node was planned but never executed — the query short-circuited before reaching it.');
    return sentences.join(' ');
  }

  if (!plan.analyzed) {
    sentences.push(
      `The planner expects ${formatRows(node.estimatedRowsTotal)} rows here, at an estimated cost of ${node.totalCost.toFixed(0)}.`,
    );
    sentences.push(explanation.why);
    return sentences.join(' ');
  }

  const loops = node.loops ?? 1;
  if (loops > 1) {
    sentences.push(
      `It ran ${formatRows(loops)} times, returning ${formatRows(node.actualRows)} rows per run — ` +
        `${formatRows(node.actualRowsTotal)} in total — and took ${formatMs(node.inclusiveMs)} altogether.`,
    );
  } else {
    sentences.push(
      `It returned ${formatRows(node.actualRowsTotal)} rows in ${formatMs(node.inclusiveMs)}.`,
    );
  }

  const totalWork = plan.totalWorkMs ?? plan.totalMs ?? 0;
  if (node.exclusiveMs !== null && totalWork > 0 && node.children.length > 0) {
    sentences.push(
      `Of that, ${formatMs(node.exclusiveMs)} was spent in this node itself (${formatPercent(node.exclusiveMs / totalWork)} of the query’s total work).`,
    );
  }

  if (node.misestimate !== null && node.misestimate >= 10) {
    const over = node.misestimateDirection === 'over';
    sentences.push(
      `The planner expected ${formatRows(node.estimatedRowsTotal)}, so it ${over ? 'overestimated' : 'underestimated'} by ${formatRatio(node.misestimate)} — ` +
        'and every decision above this node was made on that wrong number.',
    );
  }

  sentences.push(explanation.why);
  if (explanation.watch) sentences.push(explanation.watch);

  return sentences.join(' ');
}

/**
 * A narration of the whole plan: what it did, where the time went, and what the
 * planner got wrong. This is the paragraph someone reads instead of learning to
 * read plans.
 */
export function narratePlan(plan: QueryPlan): string {
  const parts: string[] = [];
  const total = plan.totalMs;

  if (!plan.analyzed) {
    parts.push(
      `This plan was not executed, so everything below is the planner’s estimate. It expects to return ` +
        `${formatRows(plan.root.estimatedRowsTotal)} rows at a total cost of ${plan.totalCost.toFixed(0)} — ` +
        'a unit that is only meaningful relative to other plans on the same server.',
    );
    parts.push(
      'Without ANALYZE there is no way to see cardinality errors, which are the most common reason a plan goes wrong.',
    );
    return parts.join(' ');
  }

  parts.push(
    `The query returned ${formatRows(plan.root.actualRowsTotal)} rows in ${formatMs(total)}` +
      (plan.planningTimeMs !== null
        ? `, after ${formatMs(plan.planningTimeMs)} of planning.`
        : '.'),
  );

  // Where the time actually went, by exclusive time. The denominator is total
  // *work*, not wall-clock: parallel workers run concurrently, so their summed
  // time legitimately exceeds elapsed time and dividing by elapsed produces
  // percentages over 100%.
  const totalWork = plan.totalWorkMs ?? total;
  const hotspots = [...plan.nodes]
    .filter((n) => !n.neverExecuted && (n.exclusiveMs ?? 0) > 0)
    .sort((a, b) => (b.exclusiveMs ?? 0) - (a.exclusiveMs ?? 0))
    .slice(0, 3);

  if (plan.isParallel && totalWork) {
    parts.push(
      `The query ran in parallel, so it performed ${formatMs(totalWork)} of work in ${formatMs(total)} of elapsed time — ` +
        'the shares below are of total work, which is why they can add up to more wall-clock than the query took.',
    );
  }

  if (hotspots.length > 0 && totalWork && totalWork > 0) {
    const top = hotspots[0] as PlanNode;
    parts.push(
      `Most of that work — ${formatMs(top.exclusiveMs)}, or ${formatPercent((top.exclusiveMs ?? 0) / totalWork)} — was spent in ${describeNode(top)}.`,
    );
    if (hotspots.length > 1) {
      const rest = hotspots
        .slice(1)
        .map((n) => `${describeNode(n)} (${formatMs(n.exclusiveMs)})`)
        .join(' and ');
      parts.push(`Next after that: ${rest}.`);
    }
  }

  const worst = [...plan.nodes]
    .filter((n) => !n.neverExecuted && n.misestimate !== null && n.misestimate >= 10)
    .sort((a, b) => (b.misestimate ?? 0) - (a.misestimate ?? 0))[0];

  if (worst) {
    parts.push(
      `The planner’s worst guess was at ${describeNode(worst)}: it expected ${formatRows(worst.estimatedRowsTotal)} rows and got ` +
        `${formatRows(worst.actualRowsTotal)}, off by ${formatRatio(worst.misestimate)}. ` +
        'Cardinality errors propagate upward — every join strategy chosen above this node was chosen on the wrong number, ' +
        'so this is usually the thing to fix first.',
    );
  } else {
    parts.push('Row estimates were broadly accurate, so the planner was working from a fair picture of the data.');
  }

  const spills = plan.nodes.filter(
    (n) => n.sortSpaceType === 'Disk' || (n.hashBatches !== null && n.hashBatches > 1),
  );
  if (spills.length > 0) {
    parts.push(
      `${spills.length === 1 ? 'One node' : `${spills.length} nodes`} ran out of work_mem and spilled to disk, which is usually ` +
        'the cheapest thing on this list to fix — it is a configuration change, not a query change.',
    );
  }

  return parts.join(' ');
}
