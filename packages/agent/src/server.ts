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
import { TUNABLE_GUCS } from './safety.ts';

const config = configFromEnv();
const db = new Database(config);
const app = express();

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
    database: probe,
    // Surfaced so the UI can warn rather than silently offering a broken feature.
    capabilities: {
      whatIfIndex: probe.hypopgInstalled,
      whatIfSettings: probe.connected,
      measuredAnalysis: probe.connected,
    },
  });
});

/** Explain and analyse one query. */
app.post('/api/analyze', async (req, res) => {
  try {
    const sql = requireSql(req.body);
    const shouldAnalyze = req.body?.analyze === true;
    res.json(await analyzeQuery(db, sql, { analyze: shouldAnalyze }));
  } catch (err) {
    fail(res, err);
  }
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
  await db.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

export { app, db };
