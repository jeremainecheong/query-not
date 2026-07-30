/**
 * The agent's HTTP surface.
 *
 * Request/response over the IR, not a one-way metrics push — because the
 * what-if loop needs a live connection and only the agent has one
 * (REQUIREMENTS.md §6.2).
 */

import express from 'express';
import cors from 'cors';

import { configFromEnv, Database, describeDbError } from './db.ts';
import {
  AgentError,
  analyzeQuery,
  verifySuggestions,
  whatIfIndex,
  whatIfSettings,
} from './explain.ts';
import { fingerprint, TUNABLE_GUCS } from './safety.ts';
import { analyzeRewrites, initParser, SqlParseError } from './rewrite.ts';
import { Store } from './store.ts';
import { buildHistory } from './history.ts';

const config = configFromEnv();
const db = new Database(config);
const app = express();

// The rewrite advisor's parser loads a wasm module once at startup. Tracked as
// a capability rather than assumed, so a load failure degrades that one feature
// instead of taking the agent down.
let parserReady = false;

/**
 * Persistence lives with the agent, inside the customer's network.
 *
 * Single-tenant by design, so there is no auth layer here: whoever can reach
 * this process is already authorised by the network. Adding accounts would buy
 * no access control that does not already exist.
 */
const store = new Store(process.env['QUERYNOT_STORE_PATH'] ?? './.querynot/store.db');

app.use(cors());
app.use(express.json({ limit: '1mb' }));

function fail(res: express.Response, err: unknown): void {
  if (err instanceof AgentError) {
    res.status(err.status).json({ error: err.message, hint: err.hint });
    return;
  }
  const { message, hint } = describeDbError(err);
  console.error('[agent]', message);
  res.status(400).json({ error: message, hint });
}

function requireSql(body: unknown): string {
  const sql = (body as { sql?: unknown })?.sql;
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    throw new AgentError('Provide a "sql" string.');
  }
  return sql;
}

app.get('/api/health', async (_req, res) => {
  const probe = await db.probe();
  res.json({
    agent: 'ok',
    statementTimeoutMs: config.statementTimeoutMs,
    tunableSettings: [...TUNABLE_GUCS],
    store: store.stats(),
    database: probe,
    // Surfaced so the UI can warn rather than silently offering a broken feature.
    capabilities: {
      whatIfIndex: probe.hypopgInstalled,
      whatIfSettings: probe.connected,
      measuredAnalysis: probe.connected,
      rewriteAdvisor: parserReady,
      persistence: true,
    },
  });
});

/**
 * Rewrite analysis on its own — no database needed.
 *
 * Useful in CI and in an editor, where you want the structural advice without
 * a connection to anything.
 */
app.post('/api/rewrite', async (req, res) => {
  try {
    const sql = requireSql(req.body);
    if (!parserReady) {
      throw new AgentError('The SQL parser failed to load; rewrite analysis is unavailable.', null, 503);
    }
    res.json({ rewrites: analyzeRewrites(sql) });
  } catch (err) {
    if (err instanceof SqlParseError) {
      res.status(400).json({
        error: err.message,
        hint: err.cursorPosition !== null ? `Parser stopped at character ${err.cursorPosition}.` : null,
      });
      return;
    }
    fail(res, err);
  }
});

/**
 * Explain and analyse one query.
 *
 * Every run is recorded, not only explicitly saved ones — plan history is only
 * useful if it accumulates without anyone remembering to press save. The slug
 * comes back so the result is immediately shareable.
 */
app.post('/api/analyze', async (req, res) => {
  try {
    const sql = requireSql(req.body);
    const shouldAnalyze = req.body?.analyze === true;
    const analysis = await analyzeQuery(db, sql, { analyze: shouldAnalyze });

    let slug: string | null = null;
    try {
      slug = store.recordAnalysis({
        fingerprint: analysis.fingerprint,
        sql,
        analyzed: analysis.plan.analyzed,
        payload: analysis,
        totalMs: analysis.plan.totalMs,
        totalWorkMs: analysis.plan.totalWorkMs,
        totalCost: analysis.plan.totalCost,
      });
    } catch (err) {
      // A storage failure must not cost the user their analysis.
      console.warn('[agent] could not record analysis:', err instanceof Error ? err.message : err);
    }

    res.json({ ...analysis, slug });
  } catch (err) {
    fail(res, err);
  }
});

// ── Persistence ──────────────────────────────────────────────────────────────

/** A previously recorded analysis, by slug — this is what a shared link opens. */
app.get('/api/analysis/:slug', (req, res) => {
  const record = store.getAnalysis(req.params.slug);
  if (!record) {
    res.status(404).json({
      error: 'No analysis with that id.',
      hint: 'Links expire when history is pruned — the 50 most recent runs per query are kept.',
    });
    return;
  }
  res.json({
    ...(record.payload as object),
    slug: record.slug,
    createdAt: record.createdAt,
    sql: record.sql,
  });
});

app.get('/api/analyses', (req, res) => {
  res.json({ analyses: store.recentAnalyses(Number(req.query['limit'] ?? 25)) });
});

/** Plan history for one query, with the points where it changed shape. */
app.get('/api/history/:fingerprint', (req, res) => {
  res.json(buildHistory(store, req.params.fingerprint));
});

app.get('/api/saved', (_req, res) => {
  res.json({ queries: store.listSavedQueries() });
});

app.post('/api/saved', (req, res) => {
  try {
    const sql = requireSql(req.body);
    const name = req.body?.name;
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new AgentError('Provide a "name" for the saved query.');
    }
    if (name.length > 120) throw new AgentError('Name is too long (max 120 characters).');
    res.json(store.saveQuery(name.trim(), sql, fingerprint(sql)));
  } catch (err) {
    fail(res, err);
  }
});

app.delete('/api/saved/:name', (req, res) => {
  const existed = store.deleteSavedQuery(req.params.name);
  if (!existed) {
    res.status(404).json({ error: 'No saved query with that name.', hint: null });
    return;
  }
  res.json({ deleted: true });
});

/**
 * Record what a what-if concluded.
 *
 * The reasoning behind an index is normally lost the moment the person who
 * tested it moves on. This keeps the DDL, the verdict, the numbers, and whether
 * it was ever actually shipped.
 */
app.post('/api/decisions', (req, res) => {
  try {
    const body = req.body ?? {};
    if (body.kind !== 'index' && body.kind !== 'settings') {
      throw new AgentError('kind must be "index" or "settings".');
    }
    if (typeof body.change !== 'string' || body.change.trim().length === 0) {
      throw new AgentError('Provide the "change" that was tested.');
    }
    if (typeof body.verdict !== 'string' || typeof body.fingerprint !== 'string') {
      throw new AgentError('Provide "verdict" and "fingerprint".');
    }
    res.json(
      store.recordDecision({
        analysisSlug: typeof body.analysisSlug === 'string' ? body.analysisSlug : null,
        fingerprint: body.fingerprint,
        kind: body.kind,
        change: body.change,
        verdict: body.verdict,
        headline: typeof body.headline === 'string' ? body.headline : '',
        costBefore: typeof body.costBefore === 'number' ? body.costBefore : null,
        costAfter: typeof body.costAfter === 'number' ? body.costAfter : null,
        costOnly: body.costOnly === true,
      }),
    );
  } catch (err) {
    fail(res, err);
  }
});

app.get('/api/decisions', (req, res) => {
  const fp = req.query['fingerprint'];
  res.json({ decisions: store.listDecisions(typeof fp === 'string' ? fp : undefined) });
});

app.patch('/api/decisions/:id', (req, res) => {
  const updated = store.markDecisionApplied(Number(req.params.id), req.body?.applied === true);
  if (!updated) {
    res.status(404).json({ error: 'No decision with that id.', hint: null });
    return;
  }
  res.json(updated);
});

/** Test a hypothetical index. */
app.post('/api/whatif/index', async (req, res) => {
  try {
    const sql = requireSql(req.body);
    const ddl = req.body?.ddl;
    if (typeof ddl !== 'string' || ddl.trim().length === 0) {
      throw new AgentError('Provide a "ddl" string containing a CREATE INDEX statement.');
    }
    res.json(await whatIfIndex(db, sql, ddl));
  } catch (err) {
    fail(res, err);
  }
});

/** Re-plan under different settings. */
app.post('/api/whatif/settings', async (req, res) => {
  try {
    const sql = requireSql(req.body);
    const settings = req.body?.settings;
    if (!settings || typeof settings !== 'object') {
      throw new AgentError('Provide a "settings" object, e.g. { "work_mem": "64MB" }.');
    }
    res.json(
      await whatIfSettings(db, sql, settings as Record<string, string>, {
        analyze: req.body?.analyze === true,
      }),
    );
  } catch (err) {
    fail(res, err);
  }
});

/**
 * Analyse, then prove. Every index suggestion is tested against a hypothetical
 * index and the ones that do not change the plan are reported as unproven,
 * rather than presented as advice.
 */
app.post('/api/analyze/verified', async (req, res) => {
  try {
    const sql = requireSql(req.body);
    const analysis = await analyzeQuery(db, sql, { analyze: req.body?.analyze === true });
    const verified = await verifySuggestions(db, sql, analysis.indexSuggestions);

    res.json({
      ...analysis,
      verifiedSuggestions: verified.map(({ suggestion, result, error }) => ({
        suggestion,
        error,
        verdict: result?.diff.summary.verdict ?? null,
        headline: result?.diff.summary.headline ?? null,
        costBefore: result?.diff.summary.costBefore ?? null,
        costAfter: result?.diff.summary.costAfter ?? null,
        costChange: result?.diff.summary.costChange ?? null,
        accessChanges: result?.diff.summary.accessChanges ?? [],
        // The honest bit: an index the planner declines to use is not advice.
        proven: result ? result.diff.summary.verdict === 'improved' : false,
      })),
    });
  } catch (err) {
    fail(res, err);
  }
});

await initParser()
  .then(() => {
    parserReady = true;
  })
  .catch((err: unknown) => {
    console.warn('[agent] SQL parser unavailable, rewrite advice disabled:', err);
  });

const port = Number(process.env['QUERYNOT_PORT'] ?? 5174);
const server = app.listen(port, () => {
  console.log(`[agent] listening on http://localhost:${port}`);
  console.log(`[agent] statement_timeout ${config.statementTimeoutMs}ms, max ${config.maxConnections} connections`);
  db.probe().then((p) => {
    if (!p.connected) {
      console.warn(`[agent] not connected: ${p.error}`);
      return;
    }
    console.log(`[agent] connected to ${p.database}`);
    if (!p.readOnlyRole) {
      console.warn('[agent] this role can write. Use a read-only role — the transaction guard is a backstop, not the plan.');
    }
    if (!p.hypopgInstalled) {
      console.warn('[agent] hypopg not installed: index what-ifs are unavailable until you CREATE EXTENSION hypopg.');
    }
  });
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[agent] ${signal} — shutting down`);
  server.close();
  store.close();
  await db.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

export { app, db };
