/**
 * Plan history and regression detection.
 *
 * This is the payoff for two things built for other reasons. The **fingerprint**
 * was built as the privacy boundary; it turns out to be exactly the key that
 * says "this is the same query as last Tuesday". The **diff engine** was built
 * to prove what-ifs; pointed at two snapshots in time instead of two
 * hypotheticals, it answers a question nothing else here could:
 *
 *   "This query's plan flipped from Index Scan to Seq Scan on 12 July,
 *    when orders crossed 2M rows."
 *
 * That is plan-regression detection, and it is the thing a saved-query list is
 * actually for. Nobody wants a list of their own SQL; they want to know when
 * something that used to be fast stopped being fast.
 */

import { diffPlans, parseExplainJson, type QueryPlan } from '@query-not/core';

import type { AnalysisRecord, Store } from './store.ts';

export interface HistoryPoint {
  slug: string;
  createdAt: string;
  analyzed: boolean;
  totalMs: number | null;
  totalCost: number;
  /** Root node type, so a shape change is visible in the series alone. */
  rootNode: string;
  /** Access methods used, e.g. ["Seq Scan on orders"]. */
  accessMethods: string[];
}

export interface Regression {
  /** The snapshot before the change. */
  fromSlug: string;
  fromAt: string;
  /** The snapshot that introduced it. */
  toSlug: string;
  toAt: string;
  verdict: string;
  headline: string;
  costBefore: number;
  costAfter: number;
  costChange: number;
  timeChange: number | null;
  accessChanges: string[];
  /** True when this made things worse rather than better. */
  worse: boolean;
}

export interface HistoryReport {
  fingerprint: string;
  sql: string | null;
  points: HistoryPoint[];
  regressions: Regression[];
  /** Plain-English summary, or null when there is nothing to say yet. */
  summary: string | null;
}

/** Pull the plan back out of a stored analysis payload. */
function planOf(record: AnalysisRecord): QueryPlan | null {
  const payload = record.payload as { plan?: unknown } | null;
  if (!payload || typeof payload !== 'object' || !payload.plan) return null;
  try {
    // Stored plans are already IR, but re-parsing is not an option — reuse the
    // structure directly.
    return payload.plan as QueryPlan;
  } catch {
    return null;
  }
}

function accessMethodsOf(plan: QueryPlan): string[] {
  return plan.nodes
    .filter((n) => n.nodeType.endsWith('Scan') && (n.relation || n.indexName))
    .map((n) => `${n.nodeType}${n.relation ? ` on ${n.relation}` : ''}${n.indexName ? ` via ${n.indexName}` : ''}`);
}

/**
 * Walk the snapshots oldest-first and report every point where the plan
 * changed materially.
 *
 * Compares each snapshot to the previous one rather than to the first, so a
 * query that drifts gradually reports each step rather than one cumulative
 * verdict that hides when it happened.
 */
export function buildHistory(store: Store, fingerprint: string, limit = 50): HistoryReport {
  const records = store.historyRecordsFor(fingerprint, limit);

  const points: HistoryPoint[] = [];
  const regressions: Regression[] = [];
  let previous: { record: AnalysisRecord; plan: QueryPlan } | null = null;

  for (const record of records) {
    const plan = planOf(record);
    if (!plan) continue;

    points.push({
      slug: record.slug,
      createdAt: record.createdAt,
      analyzed: record.analyzed,
      totalMs: record.totalMs,
      totalCost: record.totalCost,
      rootNode: plan.root.nodeType,
      accessMethods: accessMethodsOf(plan),
    });

    if (previous) {
      const { summary } = diffPlans(previous.plan, plan);
      const material = isMaterialChange(summary);
      if (material) {
        regressions.push({
          fromSlug: previous.record.slug,
          fromAt: previous.record.createdAt,
          toSlug: record.slug,
          toAt: record.createdAt,
          verdict: material.verdict,
          headline: material.headline,
          costBefore: summary.costBefore,
          costAfter: summary.costAfter,
          costChange: summary.costChange,
          timeChange: summary.timeChange,
          accessChanges: summary.accessChanges,
          worse: material.verdict === 'regressed',
        });
      }
    }

    previous = { record, plan };
  }

  return {
    fingerprint,
    sql: records[records.length - 1]?.sql ?? null,
    points,
    regressions,
    summary: summarise(points, regressions),
  };
}

/** Cost has to move by more than this before a re-run counts as a change. */
const COST_THRESHOLD = 0.05;

/**
 * Decide whether two runs differ *materially*, and in which direction.
 *
 * This deliberately does NOT use `summary.verdict`. That verdict leads with
 * measured wall-clock time, which is the right call for a what-if — the query
 * is executed twice back to back under the same conditions, so a time
 * difference means something.
 *
 * Across history it is exactly wrong. Wall-clock varies run to run with cache
 * state, concurrent load and noise, so a time-led verdict reports a regression
 * every single time the same query is re-run against unchanged data. Three
 * identical runs produced two "the plan got worse" entries before this existed,
 * and a history that cries wolf is worse than no history — the one entry that
 * matters gets buried in noise.
 *
 * So history keys off what is actually deterministic given the data: the plan's
 * **structure**, and the planner's **cost**. Both change only when the schema,
 * the statistics or the data change — which is precisely the event worth
 * surfacing. Timing is still reported on the finding, as context rather than as
 * the trigger.
 */
function isMaterialChange(
  summary: ReturnType<typeof diffPlans>['summary'],
): { verdict: 'improved' | 'regressed' | 'restructured'; headline: string } | null {
  const structural = summary.accessChanges.length > 0 || summary.nodesAdded + summary.nodesRemoved > 0;
  const costMoved = Math.abs(summary.costChange) >= COST_THRESHOLD;

  if (!structural && !costMoved) return null;

  const direction = summary.costChange > COST_THRESHOLD
    ? 'regressed'
    : summary.costChange < -COST_THRESHOLD
      ? 'improved'
      : 'restructured';

  const magnitude = `${Math.abs(summary.costChange * 100).toFixed(0)}%`;
  const change = summary.accessChanges[0];

  let headline: string;
  if (direction === 'regressed') {
    headline = `Estimated cost rose by ${magnitude}${change ? ` — ${change}` : ''}.`;
  } else if (direction === 'improved') {
    headline = `Estimated cost fell by ${magnitude}${change ? ` — ${change}` : ''}.`;
  } else {
    headline = `The plan changed shape at roughly the same cost${change ? ` — ${change}` : ''}.`;
  }

  return { verdict: direction, headline };
}

function summarise(points: HistoryPoint[], regressions: Regression[]): string | null {
  if (points.length === 0) return null;
  if (points.length === 1) {
    return 'Only one run recorded so far. Run this query again later and the plan will be compared against this baseline.';
  }

  const worse = regressions.filter((r) => r.worse);
  const first = points[0] as HistoryPoint;
  const last = points[points.length - 1] as HistoryPoint;
  const span = `${points.length} runs between ${shortDate(first.createdAt)} and ${shortDate(last.createdAt)}`;

  if (worse.length > 0) {
    const worst = worse.reduce((a, b) => (b.costChange > a.costChange ? b : a));
    const change = worst.accessChanges[0];
    return (
      `${span}. The plan got worse ${worse.length === 1 ? 'once' : `${worse.length} times`} — ` +
      `most notably on ${shortDate(worst.toAt)}${change ? `, when ${change}` : ''}. ` +
      'A plan that changes without the query changing means the data or the statistics moved underneath it.'
    );
  }

  if (regressions.length > 0) {
    return `${span}. The plan changed ${regressions.length === 1 ? 'once' : `${regressions.length} times`}, each time for the better or with no net cost change.`;
  }

  return `${span}, and the plan has not changed shape once. Whatever this query depends on has stayed stable.`;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}`;
}

/** Re-parse guard, exported so tests can round-trip a stored payload. */
export function planFromPayload(payload: unknown): QueryPlan | null {
  const p = payload as { plan?: unknown };
  if (!p?.plan) return null;
  const plan = p.plan as QueryPlan;
  return Array.isArray(plan.nodes) && plan.root ? plan : parseExplainJson(plan as unknown);
}
