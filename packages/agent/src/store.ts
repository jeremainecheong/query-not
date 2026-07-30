/**
 * Agent-side persistence.
 *
 * Everything worth keeping lives here, inside the customer's network, next to
 * the agent that produced it. Two consequences follow from that placement, and
 * both are the point rather than a side effect:
 *
 *   1. **No accounts.** This is a single-tenant deployment — whoever can reach
 *      the agent is already authorised. A login screen would add a user table,
 *      sessions and password reset while providing no access control that the
 *      network does not already provide.
 *
 *   2. **The privacy boundary holds completely.** Raw SQL never crosses a
 *      network, so it never needs fingerprinting before storage. The
 *      fingerprint is still computed, but as an *identity* key — the thing that
 *      says "this is the same query as last Tuesday" — rather than as redaction.
 *
 * Uses node:sqlite, built into Node 22: no dependency, one file on disk, and
 * critically **not the customer's database**. The agent connects to that
 * read-only, and writing our own tables into it would break the guarantee the
 * whole safety design rests on.
 */

import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

export interface AnalysisRecord {
  slug: string;
  fingerprint: string;
  sql: string;
  analyzed: boolean;
  /** The full Analysis payload, as returned by the API. */
  payload: unknown;
  totalMs: number | null;
  totalWorkMs: number | null;
  totalCost: number;
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

export interface SavedQuery {
  id: number;
  name: string;
  sql: string;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
  /** Most recent analysis for this query's fingerprint, when one exists. */
  latestSlug: string | null;
  runCount: number;
}

export interface Decision {
  id: number;
  analysisSlug: string | null;
  fingerprint: string;
  kind: 'index' | 'settings';
  /** The DDL, or a JSON object of settings. */
  change: string;
  verdict: string;
  headline: string;
  costBefore: number | null;
  costAfter: number | null;
  costOnly: boolean;
  /** Whether someone actually shipped it — closes the loop on the loop. */
  applied: boolean;
  createdAt: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS analyses (
  -- AUTOINCREMENT, not the implicit rowid: pruning deletes rows, and a plain
  -- rowid can be reused after a delete, which would make insert order go
  -- backwards. seq is guaranteed monotonic and never reused.
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL UNIQUE,
  fingerprint   TEXT NOT NULL,
  sql           TEXT NOT NULL,
  analyzed      INTEGER NOT NULL,
  payload       TEXT NOT NULL,
  total_ms      REAL,
  total_work_ms REAL,
  total_cost    REAL NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS analyses_by_query ON analyses (fingerprint, created_at DESC, seq DESC);
CREATE INDEX IF NOT EXISTS analyses_by_time ON analyses (created_at DESC, seq DESC);

CREATE TABLE IF NOT EXISTS saved_queries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  sql         TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  analysis_slug TEXT,
  fingerprint   TEXT NOT NULL,
  kind          TEXT NOT NULL,
  change_text   TEXT NOT NULL,
  verdict       TEXT NOT NULL,
  headline      TEXT NOT NULL,
  cost_before   REAL,
  cost_after    REAL,
  cost_only     INTEGER NOT NULL,
  applied       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS decisions_by_query ON decisions (fingerprint, created_at DESC, id DESC);
`;

/** URL-safe, short enough to paste in chat, long enough not to collide. */
function newSlug(): string {
  return randomBytes(6).toString('base64url');
}

function nowIso(): string {
  return new Date().toISOString();
}

export interface StoreOptions {
  /** Snapshots kept per query before the oldest are pruned. */
  historyPerQuery?: number;
}

export class Store {
  private db: DatabaseSync;
  private historyPerQuery: number;

  constructor(path: string, options: StoreOptions = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // WAL keeps reads from blocking behind a write; the agent serves the UI
    // while it records.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.historyPerQuery = options.historyPerQuery ?? 50;
  }

  // ── Analyses ───────────────────────────────────────────────────────────────

  /**
   * Record an analysis and return its shareable slug.
   *
   * Every run is recorded, not just explicitly saved ones — plan history is
   * only useful if it accumulates without anyone remembering to press save.
   */
  recordAnalysis(input: {
    fingerprint: string;
    sql: string;
    analyzed: boolean;
    payload: unknown;
    totalMs: number | null;
    totalWorkMs: number | null;
    totalCost: number;
  }): string {
    const slug = newSlug();
    this.db
      .prepare(
        `INSERT INTO analyses (slug, fingerprint, sql, analyzed, payload, total_ms, total_work_ms, total_cost, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        slug,
        input.fingerprint,
        input.sql,
        input.analyzed ? 1 : 0,
        JSON.stringify(input.payload),
        input.totalMs,
        input.totalWorkMs,
        input.totalCost,
        nowIso(),
      );

    this.pruneHistory(input.fingerprint);
    return slug;
  }

  /** Keep history bounded without silently losing the oldest baseline. */
  private pruneHistory(fingerprint: string): void {
    this.db
      .prepare(
        `DELETE FROM analyses
         WHERE fingerprint = ?
           AND slug NOT IN (
             SELECT slug FROM analyses WHERE fingerprint = ?
             ORDER BY created_at DESC, seq DESC LIMIT ?
           )`,
      )
      .run(fingerprint, fingerprint, this.historyPerQuery);
  }

  getAnalysis(slug: string): AnalysisRecord | null {
    const row = this.db.prepare('SELECT * FROM analyses WHERE slug = ?').get(slug) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      slug: row['slug'] as string,
      fingerprint: row['fingerprint'] as string,
      sql: row['sql'] as string,
      analyzed: row['analyzed'] === 1,
      payload: JSON.parse(row['payload'] as string),
      totalMs: (row['total_ms'] as number | null) ?? null,
      totalWorkMs: (row['total_work_ms'] as number | null) ?? null,
      totalCost: row['total_cost'] as number,
      createdAt: row['created_at'] as string,
    };
  }

  /** Snapshots for one query, newest first. */
  historyFor(fingerprint: string, limit = 50): AnalysisSummary[] {
    const rows = this.db
      .prepare(
        `SELECT slug, fingerprint, sql, analyzed, total_ms, total_cost, created_at
         FROM analyses WHERE fingerprint = ? ORDER BY created_at DESC, seq DESC LIMIT ?`,
      )
      .all(fingerprint, limit) as Array<Record<string, unknown>>;
    return rows.map(toSummary);
  }

  /** Full records for one query, oldest first — what regression detection walks. */
  historyRecordsFor(fingerprint: string, limit = 50): AnalysisRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM analyses WHERE fingerprint = ? ORDER BY created_at DESC, seq DESC LIMIT ?
         ) ORDER BY created_at ASC, seq ASC`,
      )
      .all(fingerprint, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      slug: row['slug'] as string,
      fingerprint: row['fingerprint'] as string,
      sql: row['sql'] as string,
      analyzed: row['analyzed'] === 1,
      payload: JSON.parse(row['payload'] as string),
      totalMs: (row['total_ms'] as number | null) ?? null,
      totalWorkMs: (row['total_work_ms'] as number | null) ?? null,
      totalCost: row['total_cost'] as number,
      createdAt: row['created_at'] as string,
    }));
  }

  recentAnalyses(limit = 25): AnalysisSummary[] {
    const rows = this.db
      .prepare(
        `SELECT slug, fingerprint, sql, analyzed, total_ms, total_cost, created_at
         FROM analyses ORDER BY created_at DESC, seq DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map(toSummary);
  }

  // ── Saved queries ──────────────────────────────────────────────────────────

  /** Upsert by name, so re-saving under the same name edits rather than duplicates. */
  saveQuery(name: string, sql: string, fingerprint: string): SavedQuery {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO saved_queries (name, sql, fingerprint, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET sql = excluded.sql,
                                         fingerprint = excluded.fingerprint,
                                         updated_at = excluded.updated_at`,
      )
      .run(name, sql, fingerprint, now, now);
    const saved = this.getSavedQuery(name);
    if (!saved) throw new Error('save failed');
    return saved;
  }

  getSavedQuery(name: string): SavedQuery | null {
    const row = this.db.prepare('SELECT * FROM saved_queries WHERE name = ?').get(name) as
      | Record<string, unknown>
      | undefined;
    return row ? this.hydrateSaved(row) : null;
  }

  listSavedQueries(): SavedQuery[] {
    const rows = this.db
      .prepare('SELECT * FROM saved_queries ORDER BY updated_at DESC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.hydrateSaved(row));
  }

  deleteSavedQuery(name: string): boolean {
    const before = this.db.prepare('SELECT count(*) AS n FROM saved_queries WHERE name = ?').get(name) as
      | { n: number }
      | undefined;
    this.db.prepare('DELETE FROM saved_queries WHERE name = ?').run(name);
    return (before?.n ?? 0) > 0;
  }

  private hydrateSaved(row: Record<string, unknown>): SavedQuery {
    const fingerprint = row['fingerprint'] as string;
    const latest = this.db
      .prepare('SELECT slug FROM analyses WHERE fingerprint = ? ORDER BY created_at DESC, seq DESC LIMIT 1')
      .get(fingerprint) as { slug: string } | undefined;
    const count = this.db
      .prepare('SELECT count(*) AS n FROM analyses WHERE fingerprint = ?')
      .get(fingerprint) as { n: number } | undefined;

    return {
      id: row['id'] as number,
      name: row['name'] as string,
      sql: row['sql'] as string,
      fingerprint,
      createdAt: row['created_at'] as string,
      updatedAt: row['updated_at'] as string,
      latestSlug: latest?.slug ?? null,
      runCount: count?.n ?? 0,
    };
  }

  // ── Decisions ──────────────────────────────────────────────────────────────

  /**
   * Record what was tested and what the what-if concluded.
   *
   * The reasoning behind an index is usually lost the moment the person who
   * ran the test moves on. This keeps it: the DDL, the verdict, the numbers,
   * and whether it was ever actually shipped.
   */
  recordDecision(input: {
    analysisSlug: string | null;
    fingerprint: string;
    kind: 'index' | 'settings';
    change: string;
    verdict: string;
    headline: string;
    costBefore: number | null;
    costAfter: number | null;
    costOnly: boolean;
  }): Decision {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO decisions (analysis_slug, fingerprint, kind, change_text, verdict, headline,
                                cost_before, cost_after, cost_only, applied, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        input.analysisSlug,
        input.fingerprint,
        input.kind,
        input.change,
        input.verdict,
        input.headline,
        input.costBefore,
        input.costAfter,
        input.costOnly ? 1 : 0,
        now,
      );
    const row = this.db
      .prepare('SELECT * FROM decisions ORDER BY id DESC LIMIT 1')
      .get() as Record<string, unknown>;
    return toDecision(row);
  }

  listDecisions(fingerprint?: string, limit = 50): Decision[] {
    const rows = (
      fingerprint
        ? this.db
            .prepare('SELECT * FROM decisions WHERE fingerprint = ? ORDER BY created_at DESC, id DESC LIMIT ?')
            .all(fingerprint, limit)
        : this.db.prepare('SELECT * FROM decisions ORDER BY created_at DESC, id DESC LIMIT ?').all(limit)
    ) as Array<Record<string, unknown>>;
    return rows.map(toDecision);
  }

  markDecisionApplied(id: number, applied: boolean): Decision | null {
    this.db.prepare('UPDATE decisions SET applied = ? WHERE id = ?').run(applied ? 1 : 0, id);
    const row = this.db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toDecision(row) : null;
  }

  stats(): { analyses: number; savedQueries: number; decisions: number; queries: number } {
    const one = (sql: string): number =>
      ((this.db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0);
    return {
      analyses: one('SELECT count(*) AS n FROM analyses'),
      savedQueries: one('SELECT count(*) AS n FROM saved_queries'),
      decisions: one('SELECT count(*) AS n FROM decisions'),
      queries: one('SELECT count(DISTINCT fingerprint) AS n FROM analyses'),
    };
  }

  close(): void {
    this.db.close();
  }
}

function toSummary(row: Record<string, unknown>): AnalysisSummary {
  return {
    slug: row['slug'] as string,
    fingerprint: row['fingerprint'] as string,
    sql: row['sql'] as string,
    analyzed: row['analyzed'] === 1,
    totalMs: (row['total_ms'] as number | null) ?? null,
    totalCost: row['total_cost'] as number,
    createdAt: row['created_at'] as string,
  };
}

function toDecision(row: Record<string, unknown>): Decision {
  return {
    id: row['id'] as number,
    analysisSlug: (row['analysis_slug'] as string | null) ?? null,
    fingerprint: row['fingerprint'] as string,
    kind: row['kind'] as 'index' | 'settings',
    change: row['change_text'] as string,
    verdict: row['verdict'] as string,
    headline: row['headline'] as string,
    costBefore: (row['cost_before'] as number | null) ?? null,
    costAfter: (row['cost_after'] as number | null) ?? null,
    costOnly: row['cost_only'] === 1,
    applied: row['applied'] === 1,
    createdAt: row['created_at'] as string,
  };
}
