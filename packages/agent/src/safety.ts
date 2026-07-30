/**
 * Query admission control.
 *
 * `EXPLAIN ANALYZE` executes the query. That single fact is why this file
 * exists, and why it runs before anything reaches a connection.
 *
 * Defence is layered, because any one layer can be argued around:
 *
 *   1. Statement shape — one statement, and it must be a read.
 *   2. READ ONLY transaction — Postgres itself refuses writes (db.ts).
 *   3. statement_timeout — a runaway query dies on its own (db.ts).
 *   4. A read-only role — the deployment's job, documented in the README.
 *
 * Layer 1 is the weakest of the four: it is textual, and textual checks on SQL
 * can always be fooled. It exists to catch mistakes, not attackers. Layers 2-4
 * are what actually hold, which is why none of them are optional.
 */

export interface AdmissionResult {
  ok: boolean;
  reason?: string;
}

/** Strip comments and string literals so keyword checks can't be smuggled past. */
function normalise(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/--[^\n]*/g, ' ') // line comments
    .replace(/'(?:[^']|'')*'/g, "''") // string literals
    .replace(/\$\$[\s\S]*?\$\$/g, "''") // dollar-quoted bodies
    .trim();
}

/** Statements that only read. Anything not on this list is refused. */
const READ_ONLY_STARTS = ['select', 'with', 'table', 'values'];

/**
 * Commands that write or change state. Checked even inside a statement that
 * starts with a read keyword, because `WITH x AS (DELETE ...) SELECT` is a
 * perfectly valid writing statement that begins with WITH.
 */
const WRITE_KEYWORDS = [
  'insert', 'update', 'delete', 'truncate', 'drop', 'create', 'alter', 'grant',
  'revoke', 'comment', 'copy', 'vacuum', 'analyze', 'reindex', 'cluster',
  'refresh', 'call', 'do', 'lock', 'set', 'reset', 'begin', 'commit',
  'rollback', 'savepoint', 'prepare', 'execute', 'deallocate', 'listen',
  'notify', 'security', 'import',
];

export function admitQuery(sql: string, options: { allowWrites?: boolean } = {}): AdmissionResult {
  const cleaned = normalise(sql);

  if (cleaned.length === 0) {
    return { ok: false, reason: 'Query is empty.' };
  }

  // Reject multiple statements. A trailing semicolon is fine; anything after
  // one is a second statement we did not agree to run.
  const withoutTrailing = cleaned.replace(/;\s*$/, '');
  if (withoutTrailing.includes(';')) {
    return {
      ok: false,
      reason: 'Multiple statements are not accepted — send one query at a time.',
    };
  }

  if (options.allowWrites) return { ok: true };

  const firstWord = withoutTrailing.split(/\s+/)[0]?.toLowerCase() ?? '';
  if (!READ_ONLY_STARTS.includes(firstWord)) {
    return {
      ok: false,
      reason:
        `Refusing to run a ${firstWord.toUpperCase() || 'non-SELECT'} statement. ` +
        'EXPLAIN ANALYZE executes what it is given, so the agent only accepts reads. ' +
        'To analyse a write, enable allowWrites — it wraps the statement in a transaction that is always rolled back, ' +
        'though note that sequences do not roll back and triggers with external side effects still fire.',
    };
  }

  // `WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x` reads like a SELECT
  // and deletes rows. Scan the whole statement, not just its first word.
  const words = new Set(withoutTrailing.toLowerCase().match(/\b[a-z]+\b/g) ?? []);
  for (const keyword of WRITE_KEYWORDS) {
    if (words.has(keyword)) {
      return {
        ok: false,
        reason:
          `Found "${keyword.toUpperCase()}" inside what looks like a read query. ` +
          'A CTE can write while the outer statement reads, so the agent refuses the whole statement rather than guess.',
      };
    }
  }

  return { ok: true };
}

/**
 * Replace literals with placeholders.
 *
 * This is the privacy boundary (REQUIREMENTS.md §7). Query text carries emails,
 * tokens and names in its literals; the agent runs inside the customer's network
 * precisely so this happens before anything leaves it. Fingerprinting and PII
 * stripping are the same operation, done once, here.
 */
export function fingerprint(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, '?')
    .replace(/\b\d+\.\d+\b/g, '?')
    .replace(/\b\d+\b/g, '?')
    .replace(/\$\d+/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Validate index DDL for the what-if engine.
 *
 * Hypothetical indexes are created by handing DDL to hypopg_create_index(), so
 * this string reaches the database. It must be an index definition and nothing
 * else.
 */
export function admitIndexDdl(ddl: string): AdmissionResult {
  const cleaned = normalise(ddl).replace(/;\s*$/, '');

  if (cleaned.includes(';')) {
    return { ok: false, reason: 'Index DDL must be a single statement.' };
  }
  if (!/^create\s+(unique\s+)?index\b/i.test(cleaned)) {
    return { ok: false, reason: 'Expected a CREATE INDEX statement.' };
  }
  // CONCURRENTLY is meaningless for a hypothetical index and rejected by HypoPG.
  if (/\bconcurrently\b/i.test(cleaned)) {
    return {
      ok: false,
      reason:
        'Drop CONCURRENTLY for the hypothetical test — nothing is being built, so there is nothing to build concurrently. ' +
        'Keep it for the real CREATE INDEX you run afterwards.',
    };
  }
  return { ok: true };
}

/**
 * Values accepted for a GUC what-if.
 *
 * An allowlist rather than a pattern: these are the settings that change plan
 * shape in ways worth exploring, and confining the set means a GUC name can
 * never become an injection vector.
 */
export const TUNABLE_GUCS = new Set([
  'work_mem',
  'random_page_cost',
  'seq_page_cost',
  'effective_cache_size',
  'cpu_tuple_cost',
  'cpu_index_tuple_cost',
  'cpu_operator_cost',
  'effective_io_concurrency',
  'max_parallel_workers_per_gather',
  'parallel_setup_cost',
  'parallel_tuple_cost',
  'jit',
  'jit_above_cost',
  'enable_seqscan',
  'enable_indexscan',
  'enable_indexonlyscan',
  'enable_bitmapscan',
  'enable_hashjoin',
  'enable_mergejoin',
  'enable_nestloop',
  'enable_sort',
  'enable_material',
  'enable_memoize',
  'plan_cache_mode',
  'default_statistics_target',
  'from_collapse_limit',
  'join_collapse_limit',
  'geqo_threshold',
]);

const GUC_VALUE = /^[A-Za-z0-9_.]+([A-Za-z]{2})?$/;

export function admitGucs(settings: Record<string, string>): AdmissionResult {
  for (const [name, value] of Object.entries(settings)) {
    if (!TUNABLE_GUCS.has(name)) {
      return {
        ok: false,
        reason: `"${name}" is not a tunable setting. Allowed: ${[...TUNABLE_GUCS].join(', ')}.`,
      };
    }
    if (typeof value !== 'string' || !GUC_VALUE.test(value)) {
      return {
        ok: false,
        reason: `Value for "${name}" must be a simple literal such as 64MB, 1.1 or on — got "${value}".`,
      };
    }
  }
  return { ok: true };
}
