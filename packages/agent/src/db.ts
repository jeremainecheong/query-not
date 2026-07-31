/**
 * The database boundary.
 *
 * Every statement the agent runs goes through `readOnlySession`, which opens a
 * READ ONLY transaction with a statement timeout and always rolls back. That is
 * belt and braces on purpose: EXPLAIN ANALYZE executes, and a rolled-back
 * read-only transaction is the difference between analysing a query and running
 * one against production.
 *
 * What a rollback does NOT undo, and the README says so plainly: sequence
 * advancement, and side effects from triggers that reach outside the database.
 */

import pg from 'pg';
import type { PoolClient } from 'pg';

const { Pool } = pg;

export interface AgentConfig {
  connectionString: string;
  /**
   * Opt-in second connection for extended-statistics proofs. CREATE STATISTICS
   * cannot be hypothetical, so proving one needs a role that can run DDL —
   * which the main connection must never hold. Point this at a disposable copy
   * (or, accepting the risks the README lists, a dev database). Null disables
   * the feature; the suggestion then ships as advice with exact DDL.
   */
  sandboxUrl: string | null;
  /** Hard ceiling on any single statement. */
  statementTimeoutMs: number;
  /** Cap on concurrent connections the agent holds. */
  maxConnections: number;
  applicationName: string;
}

export function configFromEnv(): AgentConfig {
  return {
    connectionString:
      process.env['QUERYNOT_DATABASE_URL'] ??
      process.env['DATABASE_URL'] ??
      'postgres://localhost/postgres',
    sandboxUrl: process.env['QUERYNOT_SANDBOX_URL'] ?? null,
    statementTimeoutMs: Number(process.env['QUERYNOT_STATEMENT_TIMEOUT_MS'] ?? 15_000),
    maxConnections: Number(process.env['QUERYNOT_MAX_CONNECTIONS'] ?? 4),
    applicationName: 'query-not-agent',
  };
}

export class Database {
  private pool: pg.Pool;
  private config: AgentConfig;

  // Fields are declared and assigned explicitly rather than via constructor
  // parameter properties: Node's --experimental-strip-types removes types
  // without rewriting code, so any TypeScript syntax that *emits* something
  // (parameter properties, enums, decorators) cannot be used in files the
  // agent runs directly.
  constructor(config: AgentConfig) {
    this.config = config;
    this.pool = new Pool({
      connectionString: config.connectionString,
      max: config.maxConnections,
      application_name: config.applicationName,
      // Fail fast on an unreachable database rather than hanging a request.
      connectionTimeoutMillis: 8000,
    });
    // Without a handler, an idle client dropped by the server takes the process
    // down. The pool replaces the client; we just need to not die.
    this.pool.on('error', (err) => {
      console.error('[agent] idle client error:', err.message);
    });
  }

  /**
   * Run work inside a read-only, always-rolled-back transaction.
   *
   * `SET LOCAL` scopes the timeout to the transaction, so it cannot leak into
   * another user of the same pooled connection.
   */
  async readOnlySession<T>(
    fn: (client: PoolClient) => Promise<T>,
    options: { gucs?: Record<string, string>; allowWrites?: boolean } = {},
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(options.allowWrites ? 'BEGIN' : 'BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${this.config.statementTimeoutMs}`);

      // GUC names are allowlisted upstream (safety.ts) and values are matched
      // against a strict pattern, so parameterising the identifier — which
      // Postgres does not permit for SET — is not the exposure it looks like.
      for (const [name, value] of Object.entries(options.gucs ?? {})) {
        await client.query(`SET LOCAL ${name} = '${value}'`);
      }

      return await fn(client);
    } finally {
      // Roll back unconditionally. There is no path here that should commit.
      try {
        await client.query('ROLLBACK');
      } catch {
        // A dead connection cannot be rolled back; releasing it is enough.
      }
      client.release();
    }
  }

  async probe(): Promise<{
    connected: boolean;
    version: string | null;
    database: string | null;
    readOnlyRole: boolean;
    hypopgAvailable: boolean;
    hypopgInstalled: boolean;
    hypopgHideIndex: boolean;
    error: string | null;
  }> {
    try {
      return await this.readOnlySession(async (client) => {
        const version = await client.query<{ version: string }>('SELECT version()');
        const db = await client.query<{ current_database: string }>('SELECT current_database()');

        // Can this role write? A read-only role is the deployment-level
        // guarantee we recommend, so report whether it is actually in place.
        const writable = await client.query<{ can_write: boolean }>(
          `SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS can_write`,
        );

        // can_hide probes for hypopg_hide_index by existence rather than by
        // parsing a version string: hiding arrived in hypopg 1.4.0, and the
        // function either answers or it does not.
        const hypopg = await client.query<{ available: boolean; installed: boolean; can_hide: boolean }>(
          `SELECT
             EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'hypopg') AS available,
             EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'hypopg') AS installed,
             EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'hypopg_hide_index') AS can_hide`,
        );

        return {
          connected: true,
          version: version.rows[0]?.version ?? null,
          database: db.rows[0]?.current_database ?? null,
          readOnlyRole: !(writable.rows[0]?.can_write ?? true),
          hypopgAvailable: hypopg.rows[0]?.available ?? false,
          hypopgInstalled: hypopg.rows[0]?.installed ?? false,
          hypopgHideIndex: hypopg.rows[0]?.can_hide ?? false,
          error: null,
        };
      });
    } catch (err) {
      return {
        connected: false,
        version: null,
        database: null,
        readOnlyRole: false,
        hypopgAvailable: false,
        hypopgInstalled: false,
        hypopgHideIndex: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Turn a Postgres error into something a developer can act on.
 *
 * Postgres error codes carry real information that a generic 500 throws away.
 */
export function describeDbError(err: unknown): { message: string; hint: string | null } {
  const e = err as { message?: string; code?: string; hint?: string; position?: string };
  const message = e?.message ?? String(err);

  switch (e?.code) {
    case '57014':
      return {
        message: 'Query cancelled: it exceeded the agent’s statement timeout.',
        hint: 'EXPLAIN ANALYZE runs the query, so a slow query is slow here too. Raise QUERYNOT_STATEMENT_TIMEOUT_MS, or analyse it without ANALYZE to get the plan without executing it.',
      };
    case '25006':
      return {
        message: 'The query tried to write inside a read-only transaction.',
        hint: 'The agent runs everything READ ONLY. If you meant to analyse a write, enable allowWrites explicitly.',
      };
    case '42P01':
      return { message, hint: 'The table does not exist in this database — check the search_path and the connection target.' };
    case '42703':
      return { message, hint: 'That column does not exist on the referenced table.' };
    case '42601':
      return { message, hint: 'Syntax error — the query was rejected by the parser before any plan was produced.' };
    case '42501':
      return { message, hint: 'The agent’s role lacks permission on that object. A read-only role still needs SELECT granted.' };
    case '3D000':
      return { message, hint: 'That database does not exist — check QUERYNOT_DATABASE_URL.' };
    case '28P01':
      return { message: 'Authentication failed.', hint: 'Check the credentials in QUERYNOT_DATABASE_URL.' };
    case 'ECONNREFUSED':
      return { message: 'Could not reach the database.', hint: 'Is Postgres running, and reachable from where the agent runs?' };
    default:
      return { message, hint: null };
  }
}

/**
 * Run a statement that is allowed to fail without poisoning its transaction.
 *
 * A failed statement in Postgres aborts the whole transaction: every later
 * statement then fails with 25P02 until a rollback. Inside a multi-statement
 * session where individual failures are expected and recoverable — a per-query
 * EXPLAIN over stored SQL, one of which references a since-dropped table; a
 * hypothetical re-plan that trips a timeout — that abort turns one bad query
 * into a total failure, and (worse, with hypopg) makes the backend-local
 * cleanup at the end fail too, releasing a connection with hidden state intact.
 *
 * A SAVEPOINT contains the damage. On success the savepoint is released; on
 * failure we ROLLBACK TO it, which restores the pre-statement state and leaves
 * the transaction alive, so every following statement — including cleanup —
 * still runs. The savepoint name is reused sequentially, which is safe because
 * each is released before the next is taken; do not call this concurrently on
 * one client.
 */
export async function trySavepoint<T>(
  client: PoolClient,
  run: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  await client.query('SAVEPOINT qn_sp');
  try {
    const value = await run();
    await client.query('RELEASE SAVEPOINT qn_sp');
    return { ok: true, value };
  } catch (error) {
    try {
      await client.query('ROLLBACK TO SAVEPOINT qn_sp');
      await client.query('RELEASE SAVEPOINT qn_sp');
    } catch {
      // If even the rollback fails the connection is beyond saving; the
      // session's own ROLLBACK-and-release in the finally is the backstop.
    }
    return { ok: false, error };
  }
}
