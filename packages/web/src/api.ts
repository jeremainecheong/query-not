/**
 * Client for the collector agent.
 *
 * The browser never talks to Postgres. Every call here goes to the agent, which
 * is the only thing holding a database connection (REQUIREMENTS.md §6.2).
 */

import type {
  Finding,
  FlameLayout,
  IndexSuggestion,
  PlanDiff,
  QueryPlan,
} from '@query-not/core';

export interface Health {
  agent: string;
  statementTimeoutMs: number;
  tunableSettings: string[];
  database: {
    connected: boolean;
    version: string | null;
    database: string | null;
    readOnlyRole: boolean;
    hypopgAvailable: boolean;
    hypopgInstalled: boolean;
    /** hypopg_hide_index exists — hiding arrived in hypopg 1.4.0. */
    hypopgHideIndex?: boolean;
    error: string | null;
  };
  /** The opt-in DDL sandbox for statistics proofs. Null when not configured. */
  sandbox?: {
    configured: boolean;
    connected: boolean;
    database: string | null;
    canDdl: boolean;
    error: string | null;
  } | null;
  capabilities: {
    whatIfIndex: boolean;
    whatIfSettings: boolean;
    measuredAnalysis: boolean;
    rewriteAdvisor: boolean;
    /** Generated rewrites can be proven — needs a connection and the parser. */
    proveRewrite?: boolean;
    /** Drop proofs need hypopg 1.4+ (hypopg_hide_index) on the target. */
    dropIndex?: boolean;
    /** Statistics proofs need the sandbox (connected, can DDL) and the parser. */
    proveStatistics?: boolean;
    /** Parameter sensitivity — needs a connection and the parser, no extension. */
    sensitivity?: boolean;
    persistence: boolean;
  };
  store?: { analyses: number; savedQueries: number; decisions: number; queries: number };
}

export type RewriteSeverity = 'critical' | 'warning' | 'info';

/** A schema fact a generated rewrite depends on, established at prove time. */
export interface RewritePrecondition {
  kind: string;
  why: string;
  /** Column checks carry relation/column; unique-key checks relation/columns;
      aggregate checks functions. The UI renders the composed evidence line. */
  relation?: string[];
  column?: string;
  columns?: string[];
  functions?: string[];
}

/** A ready-to-run rewritten statement, generated and structurally validated. */
export interface CandidateRewrite {
  kind: string;
  sql: string;
  byteSpan: { start: number; end: number };
  /** The replaced region in UTF-16 units, for highlighting. */
  charSpan: { start: number; end: number };
  replaced: string;
  replacement: string;
  preconditions: RewritePrecondition[];
  rationale: string;
}

export interface RewriteFinding {
  kind: string;
  severity: RewriteSeverity;
  title: string;
  detail: string;
  suggestion: string;
  /** Set when the rewrite changes results, not just performance. */
  semanticChange: string | null;
  location: number | null;
  snippet: string | null;
  /** Present when the agent generated the optimised statement itself. */
  candidate?: CandidateRewrite | null;
  /** Why no candidate was generated, when the kind supports one. */
  candidateBlocked?: string | null;
}

export interface SavedQuery {
  id: number;
  name: string;
  sql: string;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
  latestSlug: string | null;
  runCount: number;
}

export interface Decision {
  id: number;
  analysisSlug: string | null;
  fingerprint: string;
  kind: 'index' | 'settings' | 'rewrite' | 'drop-index' | 'statistics';
  change: string;
  verdict: string;
  headline: string;
  costBefore: number | null;
  costAfter: number | null;
  costOnly: boolean;
  applied: boolean;
  createdAt: string;
}

export interface AnalysisSummary {
  slug: string;
  fingerprint: string;
  sql: string;
  analyzed: boolean;
  totalMs: number | null;
  totalCost: number;
  createdAt: string;
}

export interface QueryGroup {
  fingerprint: string;
  sql: string;
  runs: number;
  firstSeen: string;
  lastSeen: string;
  lastMs: number | null;
  lastCost: number;
  savedAs: string | null;
  regressions: number;
}

export interface WorkloadEntry {
  queryId: string;
  query: string;
  calls: number;
  totalMs: number;
  meanMs: number;
  stddevMs: number | null;
  rows: number;
  sharedHit: number;
  sharedRead: number;
  share: number;
  flags: string[];
  note: string | null;
  explainable: boolean;
  notExplainableReason: string | null;
}

export interface WorkloadResponse {
  availability: { available: boolean; installed: boolean; reason: string | null; hint: string | null };
  window: {
    isDelta: boolean;
    fromAt: string | null;
    toAt: string;
    resetDetected: boolean;
    totalMs: number;
    entries: WorkloadEntry[];
  } | null;
  snapshots: number;
}

export interface HistoryPoint {
  slug: string;
  createdAt: string;
  analyzed: boolean;
  totalMs: number | null;
  totalCost: number;
  rootNode: string;
  accessMethods: string[];
}

export interface Regression {
  fromSlug: string;
  fromAt: string;
  toSlug: string;
  toAt: string;
  verdict: string;
  headline: string;
  costBefore: number;
  costAfter: number;
  costChange: number;
  timeChange: number | null;
  accessChanges: string[];
  worse: boolean;
}

export interface HistoryReport {
  fingerprint: string;
  sql: string | null;
  points: HistoryPoint[];
  regressions: Regression[];
  summary: string | null;
}

/** A CREATE STATISTICS suggestion, refined by the agent (AST + catalog probe). */
export interface StatisticsFinding {
  nodeId: string;
  relation: string;
  columns: string[];
  statName: string;
  ddl: string;
  reason: string;
  estimatedRows: number;
  actualRows: number;
  ratio: number;
  confidence: 'high' | 'medium' | 'low';
  caveat: string | null;
  /** 'plan-text' means the AST could not confirm the columns — degraded. */
  source: 'ast' | 'plan-text';
  existingState: 'none' | 'not-analysed' | 'analysed' | 'wrong-kind' | 'not-visible' | 'unknown';
  existing: { name: string; columns: string[]; kinds: string[] } | null;
  existingAdvice: string | null;
}

export interface Analysis {
  plan: QueryPlan;
  findings: Finding[];
  indexSuggestions: IndexSuggestion[];
  /** Absent on analyses recorded before the advisor existed. */
  statisticsSuggestions?: StatisticsFinding[];
  rewrites: RewriteFinding[];
  narration: string;
  flame: FlameLayout;
  fingerprint: string;
  /** Set once the run has been recorded; this is the shareable id. */
  slug?: string | null;
  createdAt?: string;
  sql?: string;
}

export interface VerifiedSuggestion {
  suggestion: IndexSuggestion;
  error: string | null;
  verdict: string | null;
  headline: string | null;
  costBefore: number | null;
  costAfter: number | null;
  costChange: number | null;
  accessChanges: string[];
  proven: boolean;
}

export interface VerifiedAnalysis extends Analysis {
  verifiedSuggestions: VerifiedSuggestion[];
}

export interface WhatIfResult {
  before: QueryPlan;
  after: QueryPlan;
  diff: PlanDiff;
  change:
    | { kind: 'index'; ddl: string }
    | { kind: 'settings'; settings: Record<string, string> }
    | { kind: 'rewrite'; sql: string }
    | { kind: 'statistics'; ddl: string };
  findingsAfter: Finding[];
  costOnly: boolean;
  note: string | null;
}

/** A precondition verdict from the catalog, with citable evidence. */
export interface PreconditionCheck {
  spec: RewritePrecondition & { role?: string; oneOf?: string[] };
  established: boolean;
  evidence: string;
}

export interface EquivalenceResult {
  status: 'match' | 'mismatch' | 'not-checkable' | 'too-many-rows';
  rowsOriginal: number | null;
  rowsRewritten: number | null;
  onlyInOriginal: number | null;
  onlyInRewritten: number | null;
  comparedAs: 'native' | 'text' | null;
  note: string;
}

export type RewriteProofOutcome =
  | 'proven'
  | 'improved-unverified'
  | 'no-effect'
  | 'regressed'
  | 'differed'
  | 'advice-only';

export interface RewriteProof {
  candidate: CandidateRewrite;
  preconditions: PreconditionCheck[];
  outcome: RewriteProofOutcome;
  planDiff: WhatIfResult | null;
  equivalence: EquivalenceResult | null;
  note: string;
}

// ── Index inventory and drop proofs ──────────────────────────────────────────

export interface IndexDisqualifier {
  kind: 'primary-key' | 'unique' | 'exclusion-constraint' | 'replica-identity' | 'constraint-backing';
  evidence: string;
}

export interface IndexInventoryEntry {
  schema: string;
  table: string;
  index: string;
  definition: string;
  sizeBytes: number;
  scans: number;
  lastScanAt: string | null;
  valid: boolean;
  droppableForPerformance: boolean;
  disqualifiers: IndexDisqualifier[];
  evidence: string;
}

export interface IndexInventory {
  statsResetAt: string | null;
  hasLastScan: boolean;
  statsNote: string;
  indexes: IndexInventoryEntry[];
}

export interface ProofSetSkip {
  source: 'store' | 'workload';
  fingerprint: string | null;
  reason: string;
}

export interface PerQueryDropResult {
  fingerprint: string;
  sql: string;
  source: 'store' | 'workload';
  usedIndex: boolean;
  verdict: 'improved' | 'regressed' | 'unchanged' | 'restructured' | null;
  headline: string | null;
  costBefore: number | null;
  costAfter: number | null;
  costChange: number | null;
  accessChanges: string[];
  error: string | null;
}

export type DropOutcome = 'no-plan-changed' | 'plans-changed-not-worse' | 'regressed';

export interface DropIndexProof {
  index: { schema: string; table: string; name: string; definition: string; sizeBytes: number };
  usage: {
    scans: number | null;
    lastScanAt: string | null;
    statsResetAt: string | null;
    evidence: string;
  };
  perQuery: PerQueryDropResult[];
  coverage: {
    tested: number;
    fromStore: number;
    fromWorkload: number;
    skipped: ProofSetSkip[];
    capped: boolean;
    cap: number;
  };
  outcome: DropOutcome;
  costOnly: true;
  note: string;
}

// ── Parameter sensitivity (mirrored from the agent's sensitivity.ts) ─────────

export interface PredicateCandidate {
  column: string | null;
  operator: string | null;
  value: string | null;
  location: number;
  chosen: boolean;
  skipped: string | null;
}

export interface FlipBoundary {
  fromLabel: string;
  toLabel: string;
  fromValue: string;
  toValue: string;
  before: string[];
  after: string[];
  costFrom: number;
  costTo: number;
  headline: string;
}

export interface SensitivityVariant {
  label: string;
  value: string;
  sql: string;
  frequency: number | null;
  /** Diff verdict against the as-written baseline; null on the baseline itself. */
  verdict: 'improved' | 'regressed' | 'unchanged' | 'restructured' | null;
  totalCost: number;
  estimatedRows: number;
  scanRows: number | null;
  signature: string[];
  /** Full plan only for the two points flanking the first flip; baseline carries it when no flip. */
  plan: QueryPlan | null;
  diff: PlanDiff | null;
}

export interface SensitivityResult {
  predicate: {
    column: string;
    relation: string[];
    operator: string;
    originalValue: string;
    location: number;
    charSpan: { start: number; end: number };
    why: string;
  };
  candidates: PredicateCandidate[];
  basis: {
    kind: 'histogram' | 'mcv';
    evidence: string;
    nDistinct: number | null;
    nullFrac: number | null;
    reltuples: number;
  };
  baseline: SensitivityVariant;
  variants: SensitivityVariant[];
  flips: FlipBoundary[];
  baselineMatchesLabel: string | null;
  narrative: string;
  costOnly: true;
  note: string;
}

export type StatisticsProofOutcome = 'estimates-fixed' | 'estimates-improved' | 'no-effect';

export interface StatisticsAccuracySide {
  estimatedRows: number;
  actualRows: number;
  ratio: number;
}

/** What a sandbox statistics proof measured. Claims are scoped to the sandbox. */
export interface StatisticsProof {
  /** The rolled-back statement that ran on the sandbox. */
  ddl: string;
  /** The durable form to actually ship: named object plus its ANALYZE. */
  adviceDdl: string;
  relation: string;
  columns: string[];
  outcome: StatisticsProofOutcome;
  accuracy: {
    before: StatisticsAccuracySide;
    after: StatisticsAccuracySide;
    nodeLabel: string;
  } | null;
  accuracyUnavailableReason: string | null;
  dependency: {
    pairs: Array<{ determinant: string[]; dependent: string; degree: number }>;
    raw: string;
  } | null;
  planDiff: WhatIfResult;
  sandbox: { database: string };
  note: string;
}

export class ApiError extends Error {
  readonly hint: string | null;
  constructor(message: string, hint: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.hint = hint;
  }
}

async function request<T>(path: string, body?: unknown, method?: string): Promise<T> {
  let response: Response;
  const verb = method ?? (body === undefined ? 'GET' : 'POST');
  try {
    response = await fetch(path, {
      method: verb,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(
      'Could not reach the agent.',
      'The agent holds the database connection and runs separately. Start it with `npm run agent`.',
    );
  }

  const payload = (await response.json().catch(() => null)) as
    | (T & { error?: string; hint?: string })
    | null;

  if (!response.ok || payload === null) {
    throw new ApiError(payload?.error ?? `Request failed (${response.status}).`, payload?.hint ?? null);
  }
  return payload;
}

export const api = {
  health: () => request<Health>('/api/health'),

  analyze: (sql: string, analyze: boolean) =>
    request<Analysis>('/api/analyze', { sql, analyze }),

  analyzeVerified: (sql: string, analyze: boolean) =>
    request<VerifiedAnalysis>('/api/analyze/verified', { sql, analyze }),

  whatIfIndex: (sql: string, ddl: string) =>
    request<WhatIfResult>('/api/whatif/index', { sql, ddl }),

  whatIfSettings: (sql: string, settings: Record<string, string>, analyze: boolean) =>
    request<WhatIfResult>('/api/whatif/settings', { sql, settings, analyze }),

  /** Rewrite advice alone — needs no database connection. */
  rewrite: (sql: string) => request<{ rewrites: RewriteFinding[] }>('/api/rewrite', { sql }),

  /**
   * Prove a generated rewrite. Only the finding's coordinates are sent — the
   * candidate is re-derived server-side, so the proof always describes the
   * agent's own transform of this SQL.
   */
  whatIfRewrite: (sql: string, kind: string, location: number | null) =>
    request<RewriteProof>('/api/whatif/rewrite', { sql, kind, location }),

  /**
   * Prove a CREATE STATISTICS suggestion on the opt-in sandbox. Coordinates
   * only — the DDL is composed server-side and always rolled back.
   */
  whatIfStatistics: (sql: string, relation: string, columns: string[]) =>
    request<StatisticsProof>('/api/whatif/statistics', { sql, relation, columns }),

  /**
   * Parameter sensitivity: re-plan the query at constants drawn from pg_stats
   * and report where the plan flips. Estimate-only by design — nothing runs.
   */
  sensitivity: (sql: string, location: number | null = null) =>
    request<SensitivityResult>('/api/whatif/sensitivity', { sql, location }),

  // ── Persistence ────────────────────────────────────────────────────────────

  /** Re-open a recorded analysis. This is what a shared link resolves to. */
  getAnalysis: (slug: string) => request<Analysis>(`/api/analysis/${encodeURIComponent(slug)}`),

  history: (fingerprint: string) =>
    request<HistoryReport>(`/api/history/${encodeURIComponent(fingerprint)}`),

  recentAnalyses: (limit = 25) =>
    request<{ analyses: AnalysisSummary[] }>(`/api/analyses?limit=${limit}`),

  queries: () => request<{ queries: QueryGroup[] }>('/api/queries'),

  workload: () => request<WorkloadResponse>('/api/workload'),

  /** Every user index with usage evidence; needs no extension. */
  indexes: () => request<IndexInventory>('/api/indexes'),

  /**
   * Prove an index is safe to drop. Only the name (and optional schema) is
   * sent — the server resolves, disqualifies, hides and re-plans in its own
   * single session, so no SQL or oid ever crosses the wire.
   */
  whatIfDropIndex: (index: string, schema: string | null) =>
    request<DropIndexProof>('/api/whatif/drop-index', { index, schema }),

  workloadSnapshot: () =>
    request<{ id: number; takenAt: string; entries: number }>('/api/workload/snapshot', {}),

  listSaved: () => request<{ queries: SavedQuery[] }>('/api/saved'),

  save: (name: string, sql: string) => request<SavedQuery>('/api/saved', { name, sql }),

  deleteSaved: (name: string) =>
    request<{ deleted: boolean }>(`/api/saved/${encodeURIComponent(name)}`, undefined, 'DELETE'),

  listDecisions: (fingerprint?: string) =>
    request<{ decisions: Decision[] }>(
      `/api/decisions${fingerprint ? `?fingerprint=${encodeURIComponent(fingerprint)}` : ''}`,
    ),

  recordDecision: (input: {
    analysisSlug: string | null;
    fingerprint: string;
    kind: 'index' | 'settings' | 'rewrite' | 'drop-index' | 'statistics';
    change: string;
    verdict: string;
    headline: string;
    costBefore: number | null;
    costAfter: number | null;
    costOnly: boolean;
  }) => request<Decision>('/api/decisions', input),

  markApplied: (id: number, applied: boolean) =>
    request<Decision>(`/api/decisions/${id}`, { applied }, 'PATCH'),
};
