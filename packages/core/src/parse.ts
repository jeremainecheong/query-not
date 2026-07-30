/**
 * Postgres `EXPLAIN (FORMAT JSON)` → plan IR.
 *
 * The two things this file exists to get right, because almost every tool gets
 * at least one of them wrong:
 *
 *   1. The loops trap. Postgres reports `Actual Total Time` and `Actual Rows`
 *      PER LOOP. A node showing 0.03ms that ran 90,000 times cost 2.7 seconds.
 *      We multiply out and lead with the total everywhere.
 *
 *   2. Inclusive vs exclusive. Both time and buffers are reported inclusive of
 *      children. "Where did the time go" is answered by exclusive (self) time,
 *      so we compute it once here rather than in every consumer.
 */

import type {
  BufferCounts,
  JitInfo,
  PlanNode,
  QueryPlan,
  SpillMedium,
  TriggerInfo,
} from './types.ts';

/** Shape of a raw Postgres EXPLAIN JSON node. Keys are Postgres' own. */
type RawNode = Record<string, unknown>;

export class PlanParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanParseError';
  }
}

function num(raw: RawNode, key: string): number | null {
  const v = raw[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(raw: RawNode, key: string): string | null {
  const v = raw[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function bool(raw: RawNode, key: string): boolean {
  return raw[key] === true;
}

function strArray(raw: RawNode, key: string): string[] | null {
  const v = raw[key];
  if (!Array.isArray(v)) return null;
  const out = v.filter((x): x is string => typeof x === 'string');
  return out.length > 0 ? out : null;
}

const ZERO_BUFFERS: BufferCounts = {
  sharedHit: 0,
  sharedRead: 0,
  sharedDirtied: 0,
  sharedWritten: 0,
  localHit: 0,
  localRead: 0,
  localDirtied: 0,
  localWritten: 0,
  tempRead: 0,
  tempWritten: 0,
};

const BUFFER_KEYS: ReadonlyArray<[keyof BufferCounts, string]> = [
  ['sharedHit', 'Shared Hit Blocks'],
  ['sharedRead', 'Shared Read Blocks'],
  ['sharedDirtied', 'Shared Dirtied Blocks'],
  ['sharedWritten', 'Shared Written Blocks'],
  ['localHit', 'Local Hit Blocks'],
  ['localRead', 'Local Read Blocks'],
  ['localDirtied', 'Local Dirtied Blocks'],
  ['localWritten', 'Local Written Blocks'],
  ['tempRead', 'Temp Read Blocks'],
  ['tempWritten', 'Temp Written Blocks'],
];

function readBuffers(raw: RawNode): BufferCounts | null {
  let present = false;
  const out: BufferCounts = { ...ZERO_BUFFERS };
  for (const [field, key] of BUFFER_KEYS) {
    const v = num(raw, key);
    if (v !== null) {
      present = true;
      out[field] = v;
    }
  }
  return present ? out : null;
}

function subtractBuffers(parent: BufferCounts, children: BufferCounts[]): BufferCounts {
  const out: BufferCounts = { ...parent };
  for (const child of children) {
    for (const [field] of BUFFER_KEYS) {
      out[field] -= child[field];
    }
  }
  // Parallel workers and CTE reuse can make this go negative; a negative block
  // count is meaningless, so clamp rather than surface an impossible number.
  for (const [field] of BUFFER_KEYS) {
    if (out[field] < 0) out[field] = 0;
  }
  return out;
}

/**
 * Cardinality error as a ratio >= 1.
 *
 * Guarded with max(x, 1) on the denominator: a node estimated at 1000 rows that
 * returned 0 is a 1000x error, not a division by zero.
 */
function computeMisestimate(
  estimated: number,
  actual: number | null,
): { ratio: number | null; direction: 'over' | 'under' | null } {
  if (actual === null) return { ratio: null, direction: null };
  const est = Math.max(estimated, 0);
  const act = Math.max(actual, 0);
  if (est === act) return { ratio: 1, direction: null };
  if (est > act) return { ratio: est / Math.max(act, 1), direction: 'over' };
  return { ratio: act / Math.max(est, 1), direction: 'under' };
}

function parseNode(
  raw: RawNode,
  ctx: { seq: number; analyzed: boolean; hasBuffers: boolean },
  depth: number,
  parentId: string | null,
): PlanNode {
  const id = `n${ctx.seq++}`;

  const loops = num(raw, 'Actual Loops');
  const actualRows = num(raw, 'Actual Rows');
  const actualTotalTime = num(raw, 'Actual Total Time');
  const planRows = num(raw, 'Plan Rows') ?? 0;

  if (actualRows !== null || loops !== null) ctx.analyzed = true;

  // `Actual Loops: 0` is how JSON format spells "(never executed)".
  const neverExecuted = loops === 0;
  const effectiveLoops = loops ?? 1;

  const actualRowsTotal =
    actualRows === null ? null : neverExecuted ? 0 : actualRows * effectiveLoops;
  const estimatedRowsTotal = neverExecuted ? 0 : planRows * effectiveLoops;

  const inclusiveMs =
    actualTotalTime === null ? null : neverExecuted ? 0 : actualTotalTime * effectiveLoops;

  const children: PlanNode[] = [];
  const rawChildren = raw['Plans'];
  if (Array.isArray(rawChildren)) {
    for (const child of rawChildren) {
      if (child && typeof child === 'object') {
        children.push(parseNode(child as RawNode, ctx, depth + 1, id));
      }
    }
  }

  const buffers = readBuffers(raw);
  if (buffers) ctx.hasBuffers = true;

  // Exclusive time. Gather/Gather Merge run children concurrently in workers,
  // so children can sum to more than the parent — clamp at zero rather than
  // report negative self time.
  let exclusiveMs: number | null = null;
  if (inclusiveMs !== null) {
    let childSum = 0;
    for (const c of children) childSum += c.inclusiveMs ?? 0;
    exclusiveMs = Math.max(inclusiveMs - childSum, 0);
  }

  const exclusiveBuffers = buffers
    ? subtractBuffers(
        buffers,
        children.map((c) => c.buffers ?? ZERO_BUFFERS),
      )
    : null;

  const { ratio, direction } = neverExecuted
    ? { ratio: null, direction: null }
    : computeMisestimate(planRows, actualRows);

  const sortSpaceType = str(raw, 'Sort Space Type');

  return {
    id,
    nodeType: str(raw, 'Node Type') ?? 'Unknown',
    depth,
    parentId,
    relationship: str(raw, 'Parent Relationship'),
    subplanName: str(raw, 'Subplan Name'),

    relation: str(raw, 'Relation Name'),
    alias: str(raw, 'Alias'),
    indexName: str(raw, 'Index Name'),
    cteName: str(raw, 'CTE Name'),
    functionName: str(raw, 'Function Name'),
    joinType: str(raw, 'Join Type'),
    scanDirection: str(raw, 'Scan Direction'),

    startupCost: num(raw, 'Startup Cost') ?? 0,
    totalCost: num(raw, 'Total Cost') ?? 0,
    planWidth: num(raw, 'Plan Width') ?? 0,

    planRows,
    actualRows,
    loops,
    estimatedRowsTotal,
    actualRowsTotal,
    misestimate: ratio,
    misestimateDirection: direction,

    actualStartupTime: num(raw, 'Actual Startup Time'),
    actualTotalTime,
    inclusiveMs,
    exclusiveMs,
    neverExecuted,

    filter: str(raw, 'Filter'),
    indexCond: str(raw, 'Index Cond'),
    recheckCond: str(raw, 'Recheck Cond'),
    joinFilter: str(raw, 'Join Filter'),
    hashCond: str(raw, 'Hash Cond'),
    mergeCond: str(raw, 'Merge Cond'),
    sortKey: strArray(raw, 'Sort Key'),
    groupKey: strArray(raw, 'Group Key'),

    rowsRemovedByFilter: num(raw, 'Rows Removed by Filter'),
    rowsRemovedByJoinFilter: num(raw, 'Rows Removed by Join Filter'),
    rowsRemovedByIndexRecheck: num(raw, 'Rows Removed by Index Recheck'),
    heapFetches: num(raw, 'Heap Fetches'),

    sortMethod: str(raw, 'Sort Method'),
    sortSpaceUsedKb: num(raw, 'Sort Space Used'),
    sortSpaceType: sortSpaceType === 'Disk' || sortSpaceType === 'Memory'
      ? (sortSpaceType as SpillMedium)
      : null,
    hashBatches: num(raw, 'Hash Batches'),
    hashPlannedBatches: num(raw, 'Original Hash Batches'),
    hashBuckets: num(raw, 'Hash Buckets'),
    peakMemoryKb: num(raw, 'Peak Memory Usage'),

    parallelAware: bool(raw, 'Parallel Aware'),
    workersPlanned: num(raw, 'Workers Planned'),
    workersLaunched: num(raw, 'Workers Launched'),

    buffers,
    exclusiveBuffers,
    ioReadTimeMs: num(raw, 'I/O Read Time'),
    ioWriteTimeMs: num(raw, 'I/O Write Time'),

    children,
  };
}

function flatten(root: PlanNode): PlanNode[] {
  const out: PlanNode[] = [];
  const stack: PlanNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as PlanNode;
    out.push(node);
    // Push reversed so the pop order is depth-first left-to-right.
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push(node.children[i] as PlanNode);
    }
  }
  return out;
}

function parseTriggers(raw: unknown): TriggerInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: TriggerInfo[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const r = t as RawNode;
    const time = num(r, 'Time');
    if (time === null) continue;
    out.push({
      name: str(r, 'Trigger Name') ?? 'unknown',
      relation: str(r, 'Relation'),
      timeMs: time,
      calls: num(r, 'Calls') ?? 0,
    });
  }
  return out;
}

function parseJit(raw: unknown): JitInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as RawNode;
  const timing = (r['Timing'] ?? {}) as RawNode;
  return {
    functions: num(r, 'Functions') ?? 0,
    totalMs: num(timing, 'Total') ?? 0,
    inliningMs: num(timing, 'Inlining') ?? 0,
    optimizationMs: num(timing, 'Optimization') ?? 0,
    emissionMs: num(timing, 'Emission') ?? 0,
  };
}

function parseSettings(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'number') out[k] = String(v);
  }
  return out;
}

/**
 * Parse Postgres EXPLAIN output in JSON format.
 *
 * Accepts the JSON string, the parsed array Postgres returns, or a bare plan
 * object — all three turn up depending on how the caller got hold of it.
 */
export function parseExplainJson(input: string | unknown, sql?: string): QueryPlan {
  let doc: unknown = input;

  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.length === 0) throw new PlanParseError('Empty EXPLAIN output.');
    try {
      doc = JSON.parse(trimmed);
    } catch {
      throw new PlanParseError(
        'Could not parse as JSON. Run EXPLAIN with FORMAT JSON — text-format plans are not supported.',
      );
    }
  }

  // Postgres wraps the result in a single-element array.
  if (Array.isArray(doc)) {
    if (doc.length === 0) throw new PlanParseError('EXPLAIN returned an empty array.');
    doc = doc[0];
  }

  if (!doc || typeof doc !== 'object') {
    throw new PlanParseError('EXPLAIN output was not an object.');
  }

  const envelope = doc as RawNode;
  // Some callers hand us the inner plan directly rather than the envelope.
  const rawPlan = (envelope['Plan'] ?? envelope) as RawNode;

  if (!rawPlan || typeof rawPlan !== 'object' || typeof rawPlan['Node Type'] !== 'string') {
    throw new PlanParseError(
      'No plan found. Expected a "Plan" object with a "Node Type" — is this EXPLAIN output?',
    );
  }

  const ctx = { seq: 0, analyzed: false, hasBuffers: false };
  const root = parseNode(rawPlan, ctx, 0, null);

  const executionTimeMs = num(envelope, 'Execution Time');
  const planningTimeMs = num(envelope, 'Planning Time');
  const nodes = flatten(root);

  // Total work across all nodes. Under parallelism this exceeds wall-clock,
  // because workers run concurrently but their time is counted individually.
  let totalWorkMs: number | null = null;
  for (const node of nodes) {
    if (node.exclusiveMs === null) continue;
    totalWorkMs = (totalWorkMs ?? 0) + node.exclusiveMs;
  }

  const totalMs = executionTimeMs ?? root.inclusiveMs;
  const isParallel =
    totalWorkMs !== null && totalMs !== null && totalMs > 0 && totalWorkMs > totalMs * 1.05;

  return {
    root,
    nodes,
    analyzed: ctx.analyzed,
    hasBuffers: ctx.hasBuffers,
    planningTimeMs,
    executionTimeMs,
    totalMs,
    totalWorkMs,
    isParallel,
    totalCost: root.totalCost,
    triggers: parseTriggers(envelope['Triggers']),
    jit: parseJit(envelope['JIT']),
    settings: parseSettings(envelope['Settings']),
    sql: sql ?? null,
  };
}

/** Look up a node by the id assigned during parsing. */
export function findNode(plan: QueryPlan, nodeId: string): PlanNode | null {
  return plan.nodes.find((n) => n.id === nodeId) ?? null;
}

/**
 * A human-readable label for a node: "Seq Scan on orders", "Index Scan using
 * orders_pkey on orders". Used by the narrator, the UI and the diff.
 */
export function describeNode(node: PlanNode): string {
  const parts = [node.nodeType];
  if (node.indexName) parts.push(`using ${node.indexName}`);
  const target = node.relation ?? node.cteName ?? node.functionName;
  if (target) {
    parts.push(`on ${target}`);
    if (node.alias && node.alias !== target) parts.push(`(${node.alias})`);
  }
  return parts.join(' ');
}
