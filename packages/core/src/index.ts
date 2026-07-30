/**
 * @query-not/core — the analysis engine.
 *
 * Pure: no database, no network, no filesystem. Everything here operates on
 * EXPLAIN output that someone else fetched. That boundary is what lets the
 * collector agent run inside a customer's network (REQUIREMENTS.md §6.2) while
 * this code runs anywhere, and it is what makes the engine testable without a
 * live Postgres.
 */

export * from './types.ts';
export { parseExplainJson, findNode, describeNode, PlanParseError } from './parse.ts';
export {
  analyze,
  composeExtendedStatisticsDdl,
  suggestExtendedStatistics,
  suggestIndexes,
} from './analyze.ts';
export type { AnalyzeOptions } from './analyze.ts';
export {
  narratePlan,
  narrateNode,
  explainNodeType,
  NODE_TYPES,
  NODE_FAMILIES,
} from './narrate.ts';
export type { NodeExplanation, NodeTypeEntry, NodeFamily } from './narrate.ts';
export { diffPlans } from './diff.ts';
export type { PlanDiff, NodeDiff, DiffSummary, DiffStatus, Verdict } from './diff.ts';
export { layoutFlame, hotspots } from './flame.ts';
export type { FlameLayout, FlameCell } from './flame.ts';
export { extractColumns, orderForIndex, quoteIdent } from './predicates.ts';
export type { ExtractedColumn, PredicateOp } from './predicates.ts';
export { consolidateDemands, extractIndexDemands, serves } from './consolidate.ts';
export type {
  ConsolidateOptions,
  ConsolidatedIndex,
  ConsolidationResult,
  DemandExtractionOptions,
  DroppedColumn,
  IndexDemand,
  WeightedDemand,
} from './consolidate.ts';
export {
  formatMs,
  formatRows,
  formatRatio,
  formatBytes,
  formatBlocks,
  formatKb,
  formatPercent,
  suggestWorkMem,
} from './format.ts';
