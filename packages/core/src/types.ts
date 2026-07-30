/**
 * Engine-neutral query plan IR.
 *
 * Parsed from Postgres `EXPLAIN (FORMAT JSON)` today, but nothing below names
 * Postgres. Other engines get adapters that produce this same shape — see
 * REQUIREMENTS.md §4.
 */

/** How a node relates to its parent. Postgres calls these "Parent Relationship". */
export type NodeRelationship =
  | 'Outer'
  | 'Inner'
  | 'Member'
  | 'InitPlan'
  | 'SubPlan'
  | 'Subquery'
  | (string & {});

export type SpillMedium = 'Memory' | 'Disk';

/**
 * Buffer accounting. Postgres reports these *inclusive* of children, so the IR
 * stores both the raw inclusive figure and a computed exclusive one.
 */
export interface BufferCounts {
  sharedHit: number;
  sharedRead: number;
  sharedDirtied: number;
  sharedWritten: number;
  localHit: number;
  localRead: number;
  localDirtied: number;
  localWritten: number;
  tempRead: number;
  tempWritten: number;
}

export interface PlanNode {
  /** Stable within a single parsed plan; assigned depth-first from the root. */
  id: string;
  nodeType: string;
  /** Depth from root, root = 0. */
  depth: number;
  parentId: string | null;
  relationship: NodeRelationship | null;
  /** Present on subplans and CTEs, e.g. "CTE recent_orders". */
  subplanName: string | null;

  // ── Targets ────────────────────────────────────────────────────────────────
  relation: string | null;
  alias: string | null;
  indexName: string | null;
  cteName: string | null;
  functionName: string | null;
  joinType: string | null;
  scanDirection: string | null;

  // ── Cost (planner's guess, arbitrary units) ────────────────────────────────
  startupCost: number;
  totalCost: number;
  planWidth: number;

  // ── Cardinality ────────────────────────────────────────────────────────────
  /** Planner estimate, PER LOOP. */
  planRows: number;
  /** Measured, PER LOOP. Null when the plan was not ANALYZEd. */
  actualRows: number | null;
  /** Number of times this node was executed. 0 means never executed. */
  loops: number | null;
  /** planRows × loops — the estimate in absolute terms. */
  estimatedRowsTotal: number;
  /** actualRows × loops — what actually flowed through. */
  actualRowsTotal: number | null;
  /**
   * Cardinality error as a ratio >= 1, or null when not measurable.
   * The single highest-value diagnostic in a plan (REQUIREMENTS.md §4).
   */
  misestimate: number | null;
  /** 'over' = planner expected more than it got. 'under' = it expected fewer. */
  misestimateDirection: 'over' | 'under' | null;

  // ── Time ───────────────────────────────────────────────────────────────────
  /** PER LOOP, as Postgres reports it. Rarely what you want — see inclusiveMs. */
  actualStartupTime: number | null;
  actualTotalTime: number | null;
  /** actualTotalTime × loops. Total wall time in this subtree. */
  inclusiveMs: number | null;
  /** inclusiveMs minus children's inclusiveMs. What the flame graph is weighted by. */
  exclusiveMs: number | null;
  /** True when this node was planned but never run (loops === 0). */
  neverExecuted: boolean;

  // ── Predicates ─────────────────────────────────────────────────────────────
  filter: string | null;
  indexCond: string | null;
  recheckCond: string | null;
  joinFilter: string | null;
  hashCond: string | null;
  mergeCond: string | null;
  sortKey: string[] | null;
  groupKey: string[] | null;

  // ── Work performed then discarded ──────────────────────────────────────────
  rowsRemovedByFilter: number | null;
  rowsRemovedByJoinFilter: number | null;
  rowsRemovedByIndexRecheck: number | null;
  /** Index-only scans that still had to visit the heap: a visibility-map problem. */
  heapFetches: number | null;

  // ── Spills ─────────────────────────────────────────────────────────────────
  sortMethod: string | null;
  sortSpaceUsedKb: number | null;
  sortSpaceType: SpillMedium | null;
  hashBatches: number | null;
  /** Postgres reports "Original Hash Batches"; > planned means it spilled mid-flight. */
  hashPlannedBatches: number | null;
  hashBuckets: number | null;
  peakMemoryKb: number | null;

  // ── Parallelism ────────────────────────────────────────────────────────────
  parallelAware: boolean;
  workersPlanned: number | null;
  workersLaunched: number | null;

  // ── I/O ────────────────────────────────────────────────────────────────────
  buffers: BufferCounts | null;
  /** Buffers minus children's buffers. */
  exclusiveBuffers: BufferCounts | null;
  ioReadTimeMs: number | null;
  ioWriteTimeMs: number | null;

  children: PlanNode[];
}

export interface TriggerInfo {
  name: string;
  relation: string | null;
  timeMs: number;
  calls: number;
}

export interface JitInfo {
  functions: number;
  totalMs: number;
  inliningMs: number;
  optimizationMs: number;
  emissionMs: number;
}

export interface QueryPlan {
  root: PlanNode;
  /** Every node, depth-first. Same objects as the tree — indexed for lookup. */
  nodes: PlanNode[];
  /** True when parsed from EXPLAIN ANALYZE. Gates every measurement-based rule. */
  analyzed: boolean;
  /** True when BUFFERS was requested. */
  hasBuffers: boolean;
  planningTimeMs: number | null;
  executionTimeMs: number | null;
  /** executionTimeMs when present, else the root's inclusive time. Wall-clock. */
  totalMs: number | null;
  /**
   * Sum of every node's exclusive time — total work done, not elapsed time.
   *
   * These differ under parallelism: three workers each spending 13ms is 39ms of
   * work in 13ms of wall-clock. Using wall-clock as the denominator for "share
   * of time" is what produces nonsense like "this node was 202% of the query",
   * so share-of-work calculations use this instead.
   */
  totalWorkMs: number | null;
  /** True when the plan did more work than wall-clock elapsed, i.e. it ran in parallel. */
  isParallel: boolean;
  totalCost: number;
  triggers: TriggerInfo[];
  jit: JitInfo | null;
  /** Non-default GUCs Postgres reported. The plan is a function of these. */
  settings: Record<string, string>;
  /** The SQL this plan came from, when known. */
  sql: string | null;
}

// ── Findings ─────────────────────────────────────────────────────────────────

export type Severity = 'critical' | 'warning' | 'info';

export type FindingKind =
  | 'cardinality-misestimate'
  | 'sort-spilled-to-disk'
  | 'hash-join-spilled'
  | 'filter-waste'
  | 'seq-scan-candidate'
  | 'nested-loop-blowup'
  | 'lossy-bitmap-recheck'
  | 'heap-fetches'
  | 'workers-not-launched'
  | 'time-hotspot'
  | 'temp-file-io'
  | 'cold-cache'
  | 'trigger-overhead'
  | 'jit-overhead'
  | 'not-analyzed';

export interface Finding {
  kind: FindingKind;
  severity: Severity;
  /** The node this is about. Null for plan-wide findings. */
  nodeId: string | null;
  title: string;
  /** What was measured. Plain English, specific numbers, no advice. */
  detail: string;
  /** What to do about it. Null when we can measure the problem but not the fix. */
  suggestion: string | null;
  /**
   * Ranking weight. Milliseconds attributable to this finding where we can
   * estimate them, otherwise a relative score. Sorting by this puts the
   * finding that costs the most time first.
   */
  impactMs: number;
  /** Structured facts for the UI to render as chips. */
  evidence: Record<string, string | number>;
}

// ── Index advice ─────────────────────────────────────────────────────────────

export interface IndexSuggestion {
  /** Node that motivated this suggestion. */
  nodeId: string;
  relation: string;
  columns: string[];
  /** Ready-to-run DDL. */
  ddl: string;
  reason: string;
  /**
   * We extract columns from predicate text, which is a heuristic and can be
   * wrong on complex expressions. Never present these as certain — they are
   * *hypotheses to be tested* by the what-if engine, which is the whole point.
   */
  confidence: 'high' | 'medium' | 'low';
  /** Set when the predicate can't use a plain b-tree index as written. */
  caveat: string | null;
}
