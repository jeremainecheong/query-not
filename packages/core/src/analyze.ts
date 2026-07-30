/**
 * The findings engine.
 *
 * Rules over the IR. Every rule states what it *measured* — specific numbers,
 * no adjectives — and, where a fix is knowable, what to do. Rules that cannot
 * be measured from the plan are not guessed at.
 *
 * Findings carry `impactMs` so the list sorts by what actually costs time
 * rather than by rule order. A 40x misestimate on a node that ran for 0.2ms is
 * true and irrelevant; it should rank below a disk spill that cost 3 seconds.
 */

import { describeNode } from './parse.ts';
import { extractColumns, orderForIndex, quoteIdent } from './predicates.ts';
import {
  formatBlocks,
  formatKb,
  formatMs,
  formatPercent,
  formatRatio,
  formatRows,
  suggestWorkMem,
} from './format.ts';
import type { Finding, IndexSuggestion, PlanNode, QueryPlan, Severity } from './types.ts';

export interface AnalyzeOptions {
  /** Ratio at or above which a cardinality error is worth reporting. */
  misestimateWarn?: number;
  misestimateCritical?: number;
  /** Fraction of a node's rows discarded by a filter before we flag it. */
  filterWasteFraction?: number;
  /** Absolute row floor, so tiny tables don't generate noise. */
  minRowsForNoise?: number;
  /** Share of total runtime that makes a node a hotspot. */
  hotspotFraction?: number;
}

const DEFAULTS: Required<AnalyzeOptions> = {
  misestimateWarn: 10,
  misestimateCritical: 100,
  filterWasteFraction: 0.9,
  minRowsForNoise: 100,
  hotspotFraction: 0.3,
};

/** Rows Removed by Filter is reported per loop, like everything else. */
function totalRemoved(node: PlanNode, perLoop: number | null): number {
  if (perLoop === null) return 0;
  return perLoop * (node.loops ?? 1);
}

function isScan(node: PlanNode): boolean {
  return node.nodeType.endsWith('Scan');
}

export function analyze(plan: QueryPlan, options: AnalyzeOptions = {}): Finding[] {
  const opts = { ...DEFAULTS, ...options };
  const findings: Finding[] = [];
  // Share-of-work uses total work, not wall-clock. Under parallelism the two
  // differ, and dividing a node's time by wall-clock yields percentages above
  // 100% — which is not a rounding artefact but a category error.
  const total = plan.totalWorkMs ?? plan.totalMs ?? plan.root.inclusiveMs ?? 0;

  if (!plan.analyzed) {
    findings.push({
      kind: 'not-analyzed',
      severity: 'info',
      nodeId: null,
      title: 'Estimates only — this plan was not executed',
      detail:
        'This is EXPLAIN without ANALYZE, so every row count below is the planner’s guess and no timings exist. ' +
        'Cardinality errors are the most common cause of a bad plan, and they are invisible here by definition.',
      suggestion:
        'Re-run with EXPLAIN (ANALYZE, BUFFERS) to compare estimates against reality. Note that this executes the query.',
      impactMs: 0,
      evidence: { mode: 'EXPLAIN' },
    });
  }

  for (const node of plan.nodes) {
    if (node.neverExecuted) continue;
    findings.push(...analyzeNode(node, plan, opts, total));
  }

  findings.push(...analyzePlanWide(plan, total));

  // A node with a specific diagnosis doesn't also need "this node was slow".
  const specific = new Set(
    findings.filter((f) => f.kind !== 'time-hotspot' && f.nodeId).map((f) => f.nodeId as string),
  );
  const deduped = findings.filter((f) => !(f.kind === 'time-hotspot' && specific.has(f.nodeId ?? '')));

  const severityRank: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  return deduped.sort(
    (a, b) => b.impactMs - a.impactMs || severityRank[a.severity] - severityRank[b.severity],
  );
}

function analyzeNode(
  node: PlanNode,
  plan: QueryPlan,
  opts: Required<AnalyzeOptions>,
  total: number,
): Finding[] {
  const out: Finding[] = [];
  const label = describeNode(node);
  const exclusive = node.exclusiveMs ?? 0;
  const inclusive = node.inclusiveMs ?? 0;

  // ── Cardinality misestimate ───────────────────────────────────────────────
  if (node.misestimate !== null && node.misestimate >= opts.misestimateWarn) {
    const significant =
      Math.max(node.actualRowsTotal ?? 0, node.estimatedRowsTotal) >= opts.minRowsForNoise ||
      inclusive >= 1;
    if (significant) {
      const over = node.misestimateDirection === 'over';
      out.push({
        kind: 'cardinality-misestimate',
        severity: node.misestimate >= opts.misestimateCritical ? 'critical' : 'warning',
        nodeId: node.id,
        title: `Planner ${over ? 'over' : 'under'}estimated ${label} by ${formatRatio(node.misestimate)}`,
        detail:
          `Expected ${formatRows(node.estimatedRowsTotal)} rows, got ${formatRows(node.actualRowsTotal)}. ` +
          (over
            ? 'Overestimating makes the planner too cautious — it may pick a hash join or sequential scan where an index would have won.'
            : 'Underestimating is the more dangerous direction: the planner picks strategies that are cheap for a few rows and catastrophic for many, such as a nested loop.'),
        suggestion:
          'Start with statistics: run ANALYZE on the underlying table. If the columns in this predicate are correlated, ' +
          'plain per-column statistics cannot represent that — CREATE STATISTICS (dependencies, mcv) teaches the planner the relationship.',
        impactMs: inclusive,
        evidence: {
          estimated: formatRows(node.estimatedRowsTotal),
          actual: formatRows(node.actualRowsTotal),
          ratio: formatRatio(node.misestimate),
          direction: node.misestimateDirection ?? 'n/a',
        },
      });
    }
  }

  // ── Sort spilled to disk ──────────────────────────────────────────────────
  if (node.sortSpaceType === 'Disk') {
    const usedKb = node.sortSpaceUsedKb ?? 0;
    out.push({
      kind: 'sort-spilled-to-disk',
      severity: 'critical',
      nodeId: node.id,
      title: `Sort spilled to disk (${formatKb(usedKb)})`,
      detail:
        `This sort needed ${formatKb(usedKb)} but work_mem was too small to hold it, so Postgres wrote to temporary files ` +
        `and merged them back (${node.sortMethod ?? 'external sort'}). Disk sorts are orders of magnitude slower than in-memory ones.`,
      suggestion: `Raise work_mem to about ${suggestWorkMem(usedKb)} for this query — it can be set per-session or per-role rather than globally, which matters because work_mem is allocated per sort node per connection.`,
      impactMs: exclusive,
      evidence: {
        sortMethod: node.sortMethod ?? 'unknown',
        diskUsed: formatKb(usedKb),
        suggestedWorkMem: suggestWorkMem(usedKb),
      },
    });
  }

  // ── Hash spilled to batches ───────────────────────────────────────────────
  if (node.hashBatches !== null && node.hashBatches > 1) {
    const planned = node.hashPlannedBatches;
    const unplanned = planned !== null && node.hashBatches > planned;
    const peakKb = node.peakMemoryKb ?? 0;
    out.push({
      kind: 'hash-join-spilled',
      severity: 'warning',
      nodeId: node.id,
      title: `Hash spilled into ${formatRows(node.hashBatches)} batches`,
      detail:
        `The hash table did not fit in work_mem, so it was split across ${formatRows(node.hashBatches)} batches, ` +
        `each requiring a separate pass over the data.` +
        (unplanned
          ? ` Worse, the planner expected only ${formatRows(planned)} — it discovered the overflow mid-execution, which usually points at an underestimated input.`
          : ''),
      suggestion:
        peakKb > 0
          ? `Raise work_mem to about ${suggestWorkMem(peakKb)} so the hash table fits in one batch.`
          : 'Raise work_mem so the hash table fits in a single batch, or reduce the number of rows reaching this node.',
      impactMs: exclusive,
      evidence: {
        batches: node.hashBatches,
        plannedBatches: planned ?? 'n/a',
        peakMemory: formatKb(peakKb),
      },
    });
  }

  // ── Work done then thrown away ────────────────────────────────────────────
  const removed = totalRemoved(node, node.rowsRemovedByFilter);
  const kept = node.actualRowsTotal ?? 0;
  if (removed > 0 && removed + kept > 0) {
    const discardFraction = removed / (removed + kept);
    if (discardFraction >= opts.filterWasteFraction && removed >= 1000) {
      const seqScan = node.nodeType === 'Seq Scan';
      out.push({
        kind: seqScan ? 'seq-scan-candidate' : 'filter-waste',
        severity: exclusive > total * 0.15 ? 'critical' : 'warning',
        nodeId: node.id,
        title: seqScan
          ? `Sequential scan reads ${formatRows(removed + kept)} rows to return ${formatRows(kept)}`
          : `${label} discards ${formatPercent(discardFraction)} of what it reads`,
        detail:
          `${formatRows(removed)} rows were read and then thrown away by the filter, keeping only ${formatRows(kept)} ` +
          `(${formatPercent(discardFraction)} wasted). ` +
          (seqScan
            ? 'Every discarded row still cost a read. An index matching this predicate would let Postgres skip them entirely.'
            : 'The filter is being applied after the rows have already been fetched.'),
        suggestion: seqScan
          ? 'Add an index covering this predicate — see the index suggestions, which can be tested with the what-if engine before you build anything.'
          : 'Consider whether this predicate can be pushed down to the scan, or covered by an index.',
        impactMs: exclusive * discardFraction,
        evidence: {
          rowsRead: formatRows(removed + kept),
          rowsReturned: formatRows(kept),
          discarded: formatPercent(discardFraction),
          filter: node.filter ?? '',
        },
      });
    }
  }

  // ── Nested loop driving a large inner side ────────────────────────────────
  if (node.nodeType === 'Nested Loop' && node.children.length >= 2) {
    const inner = node.children[1] as PlanNode;
    const innerLoops = inner.loops ?? 1;
    if (innerLoops >= 1000 && (inner.inclusiveMs ?? 0) > total * 0.1) {
      out.push({
        kind: 'nested-loop-blowup',
        severity: 'critical',
        nodeId: node.id,
        title: `Nested loop executes its inner side ${formatRows(innerLoops)} times`,
        detail:
          `The inner side (${describeNode(inner)}) ran ${formatRows(innerLoops)} times, costing ${formatMs(inner.inclusiveMs)} in total — ` +
          `${formatMs(inner.actualTotalTime)} per iteration. Nested loops are the right choice for a handful of outer rows and ` +
          'a disaster for many, which is why an underestimated outer side turns into exactly this shape.',
        suggestion:
          'Fix the row estimate on the outer side first — the planner chose this join because it expected far fewer iterations. ' +
          'If the estimate is already correct, an index on the inner side’s join key, or forcing a hash join by fixing statistics, is the next lever.',
        impactMs: inner.inclusiveMs ?? 0,
        evidence: {
          loops: formatRows(innerLoops),
          perIteration: formatMs(inner.actualTotalTime),
          innerTotal: formatMs(inner.inclusiveMs),
        },
      });
    }
  }

  // ── Lossy bitmap ──────────────────────────────────────────────────────────
  const recheck = totalRemoved(node, node.rowsRemovedByIndexRecheck);
  if (recheck > 0) {
    out.push({
      kind: 'lossy-bitmap-recheck',
      severity: 'warning',
      nodeId: node.id,
      title: `Bitmap scan went lossy, rechecking ${formatRows(recheck)} rows`,
      detail:
        'The bitmap grew too large for work_mem, so Postgres degraded from tracking individual tuples to tracking whole pages. ' +
        `Every tuple on those pages then had to be re-tested against the condition — ${formatRows(recheck)} of them failed.`,
      suggestion: 'Raise work_mem so the bitmap can stay exact.',
      impactMs: exclusive * 0.5,
      evidence: { rowsRechecked: formatRows(recheck), recheckCond: node.recheckCond ?? '' },
    });
  }

  // ── Index-only scan still hitting the heap ────────────────────────────────
  if (node.heapFetches !== null && node.heapFetches > 0 && kept > 0) {
    const fetchFraction = node.heapFetches / Math.max(kept, 1);
    if (fetchFraction > 0.1 && node.heapFetches > 1000) {
      out.push({
        kind: 'heap-fetches',
        severity: 'warning',
        nodeId: node.id,
        title: `Index-only scan fell back to the heap ${formatRows(node.heapFetches)} times`,
        detail:
          `An index-only scan should answer from the index alone, but ${formatRows(node.heapFetches)} rows ` +
          `(${formatPercent(fetchFraction)}) required a heap visit because the visibility map marks their pages as not all-visible. ` +
          'That happens when a table has been written to more recently than it has been vacuumed.',
        suggestion: 'VACUUM the table to refresh the visibility map, and consider a more aggressive autovacuum setting if it recurs.',
        impactMs: exclusive * fetchFraction,
        evidence: {
          heapFetches: formatRows(node.heapFetches),
          rowsReturned: formatRows(kept),
          fraction: formatPercent(fetchFraction),
        },
      });
    }
  }

  // ── Parallel workers requested but not granted ────────────────────────────
  if (
    node.workersPlanned !== null &&
    node.workersLaunched !== null &&
    node.workersLaunched < node.workersPlanned
  ) {
    out.push({
      kind: 'workers-not-launched',
      severity: 'warning',
      nodeId: node.id,
      title: `Only ${node.workersLaunched} of ${node.workersPlanned} parallel workers started`,
      detail:
        'The planner costed this query assuming more parallelism than it received, so the plan it chose was optimised for a ' +
        'machine that never showed up. The remaining work fell to the leader process.',
      suggestion:
        'Check max_parallel_workers and max_parallel_workers_per_gather, and whether concurrent queries are exhausting the worker pool.',
      impactMs: exclusive * 0.3,
      evidence: { planned: node.workersPlanned, launched: node.workersLaunched },
    });
  }

  // ── Cold cache ────────────────────────────────────────────────────────────
  const buf = node.exclusiveBuffers;
  if (buf) {
    const reads = buf.sharedRead;
    const touched = reads + buf.sharedHit;
    if (reads > 5000 && touched > 0 && reads / touched > 0.5) {
      out.push({
        kind: 'cold-cache',
        severity: 'info',
        nodeId: node.id,
        title: `${formatBlocks(reads)} read from outside shared buffers`,
        detail:
          `${formatPercent(reads / touched)} of this node’s block accesses missed the buffer cache. ` +
          'That may mean the working set exceeds shared_buffers, or simply that this was a cold first run.',
        suggestion:
          'Re-run the query to see whether the reads become hits. If they persist, the working set is larger than the cache — ' +
          'which is an argument for reading fewer blocks (a better index) before it is an argument for more RAM.',
        impactMs: exclusive * 0.2,
        evidence: {
          blocksRead: formatBlocks(reads),
          blocksHit: formatBlocks(buf.sharedHit),
          missRate: formatPercent(reads / touched),
        },
      });
    }
    if (buf.tempRead > 0 || buf.tempWritten > 0) {
      out.push({
        kind: 'temp-file-io',
        severity: 'warning',
        nodeId: node.id,
        title: `Wrote ${formatBlocks(buf.tempWritten)} of temporary files`,
        detail:
          `This node spilled to temporary files — ${formatBlocks(buf.tempWritten)} written, ${formatBlocks(buf.tempRead)} read back. ` +
          'Temp file I/O is the fingerprint of an operation that did not fit in work_mem.',
        suggestion: 'Raise work_mem, or reduce the volume of rows reaching this node.',
        impactMs: exclusive * 0.4,
        evidence: {
          tempWritten: formatBlocks(buf.tempWritten),
          tempRead: formatBlocks(buf.tempRead),
        },
      });
    }
  }

  // ── Plain hotspot, when nothing more specific applies ─────────────────────
  if (total > 0 && exclusive / total >= opts.hotspotFraction && exclusive > 1) {
    out.push({
      kind: 'time-hotspot',
      severity: 'warning',
      nodeId: node.id,
      title: `${label} accounts for ${formatPercent(exclusive / total)} of total work`,
      detail:
        `${formatMs(exclusive)} of the query’s ${formatMs(total)} of work was spent in this node itself, excluding its children` +
        (isScan(node) ? ` while returning ${formatRows(kept)} rows.` : '.') +
        (plan.isParallel
          ? ' Work totals exceed elapsed time here because parallel workers ran concurrently.'
          : ''),
      suggestion: null,
      impactMs: exclusive,
      evidence: {
        selfTime: formatMs(exclusive),
        shareOfTotal: formatPercent(exclusive / total),
        rows: formatRows(kept),
      },
    });
  }

  return out;
}

function analyzePlanWide(plan: QueryPlan, total: number): Finding[] {
  const out: Finding[] = [];

  const triggerMs = plan.triggers.reduce((sum, t) => sum + t.timeMs, 0);
  if (triggerMs > 0 && total > 0 && triggerMs / total > 0.1) {
    out.push({
      kind: 'trigger-overhead',
      severity: 'warning',
      nodeId: null,
      title: `Triggers account for ${formatPercent(triggerMs / total)} of runtime`,
      detail:
        `${formatMs(triggerMs)} was spent in triggers (${plan.triggers.map((t) => t.name).join(', ')}), ` +
        'which is work the plan tree does not show at all.',
      suggestion: 'Trigger cost is invisible in the plan tree — check whether this work belongs in the transaction at all.',
      impactMs: triggerMs,
      evidence: { triggerTime: formatMs(triggerMs), triggerCount: plan.triggers.length },
    });
  }

  if (plan.jit && plan.jit.totalMs > 0 && total > 0 && plan.jit.totalMs / total > 0.2) {
    out.push({
      kind: 'jit-overhead',
      severity: 'warning',
      nodeId: null,
      title: `JIT compilation cost ${formatMs(plan.jit.totalMs)} (${formatPercent(plan.jit.totalMs / total)} of runtime)`,
      detail:
        `Postgres compiled ${plan.jit.functions} functions to speed this query up, and the compilation itself took longer than it plausibly saved. ` +
        'This usually happens when a high estimated cost triggers JIT on a query that is actually fast.',
      suggestion:
        'Raise jit_above_cost, or set jit = off for this workload. An inflated cost estimate is often the real cause, so check the estimates first.',
      impactMs: plan.jit.totalMs,
      evidence: {
        jitTime: formatMs(plan.jit.totalMs),
        functions: plan.jit.functions,
        share: formatPercent(plan.jit.totalMs / total),
      },
    });
  }

  return out;
}

/**
 * Propose indexes for scans that are doing avoidable work.
 *
 * These are hypotheses. The what-if engine exists to test them — a suggestion
 * that does not change the plan when applied hypothetically is a suggestion
 * that should never have reached the user, and this is how we find that out
 * without building anything.
 */
export function suggestIndexes(plan: QueryPlan, options: AnalyzeOptions = {}): IndexSuggestion[] {
  const opts = { ...DEFAULTS, ...options };
  const out: IndexSuggestion[] = [];
  const seen = new Set<string>();

  for (const node of plan.nodes) {
    if (node.neverExecuted || !node.relation) continue;
    const isSeqScan = node.nodeType === 'Seq Scan';
    const isBitmapHeap = node.nodeType === 'Bitmap Heap Scan';
    if (!isSeqScan && !isBitmapHeap) continue;

    const predicate = node.filter ?? node.recheckCond;
    if (!predicate) continue;

    const removed = totalRemoved(node, node.rowsRemovedByFilter);
    const kept = node.actualRowsTotal ?? 0;

    // On an un-analyzed plan we have no measured selectivity, so fall back to
    // the estimate rather than skipping the suggestion entirely.
    const selective = plan.analyzed
      ? removed + kept > 0 && removed / (removed + kept) >= opts.filterWasteFraction && removed >= 1000
      : node.planRows < node.totalCost;
    if (!selective) continue;

    const columns = orderForIndex(extractColumns(predicate));
    if (columns.length === 0) continue;

    const names = columns.map((c) => quoteIdent(c.name));
    const key = `${node.relation}(${names.join(',')})`;
    if (seen.has(key)) continue;
    seen.add(key);

    const wrapped = columns.find((c) => c.wrappedIn !== null);
    const cast = columns.find((c) => c.castTo !== null);
    const pattern = columns.find((c) => c.op === 'pattern');

    let caveat: string | null = null;
    let confidence: IndexSuggestion['confidence'] = 'high';

    if (wrapped) {
      caveat =
        `The predicate wraps ${wrapped.name} in ${wrapped.wrappedIn}(), which a plain b-tree index on the column cannot serve. ` +
        `Either rewrite the predicate as a range over ${wrapped.name}, or build an expression index on ${wrapped.wrappedIn}(${wrapped.name}).`;
      confidence = 'low';
    } else if (pattern) {
      caveat =
        `${pattern.name} is matched with a pattern operator. A b-tree index only helps for left-anchored patterns ('abc%') ` +
        'and only under the C collation or with a text_pattern_ops operator class; otherwise use a trigram (pg_trgm) index.';
      confidence = 'low';
    } else if (cast) {
      caveat =
        `${cast.name} is cast to ${cast.castTo} before comparison. If the cast is on the column rather than the parameter, ` +
        'the index will be ignored — check that the parameter type matches the column type.';
      confidence = 'medium';
    } else if (columns.length > 2) {
      confidence = 'medium';
    }

    out.push({
      nodeId: node.id,
      relation: node.relation,
      columns: columns.map((c) => c.name),
      ddl: `CREATE INDEX CONCURRENTLY ON ${quoteIdent(node.relation)} (${names.join(', ')});`,
      reason:
        `${describeNode(node)} reads ${formatRows(removed + kept)} rows and keeps ${formatRows(kept)}. ` +
        `Columns ordered equality-first, which is what lets a composite index use more than its leading column.`,
      confidence,
      caveat,
    });
  }

  return out;
}
