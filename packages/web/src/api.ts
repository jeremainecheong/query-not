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
    error: string | null;
  };
  capabilities: {
    whatIfIndex: boolean;
    whatIfSettings: boolean;
    measuredAnalysis: boolean;
  };
}

export interface Analysis {
  plan: QueryPlan;
  findings: Finding[];
  indexSuggestions: IndexSuggestion[];
  narration: string;
  flame: FlameLayout;
  fingerprint: string;
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
  change: { kind: 'index'; ddl: string } | { kind: 'settings'; settings: Record<string, string> };
  findingsAfter: Finding[];
  costOnly: boolean;
  note: string | null;
}

export class ApiError extends Error {
  readonly hint: string | null;
  constructor(message: string, hint: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.hint = hint;
  }
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
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
};
