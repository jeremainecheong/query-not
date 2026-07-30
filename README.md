# query-not

A PostgreSQL query optimiser that doesn't just *show* you a slow plan — it proves what
would fix it.

Paste a query and query-not finds the bottleneck, proposes a fix, and then **re-plans
the query against a hypothetical index to prove the fix works** — before you build
anything.

```
plan(sql, world) → IR          world = (schema, statistics, GUCs, params, extensions)
diff(IR, IR)     → change set
```

Everything is a perturbation of that world: add a hypothetical index, raise `work_mem`,
rewrite the SQL — then re-plan and diff. Suggestions arrive with evidence attached.

> **Estimated cost fell by 84% — Seq Scan → Index Scan using
> `hypothetical btree_orders_status_created_at`.**
> *Hypothetical indexes cannot be executed against, so this compares planner cost
> estimates rather than measured time.*

That second sentence is the point. The tool says what it proved and what it didn't.

## What works today

- **Plan IR + parser** — engine-neutral, from `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`.
  Handles the loops trap (per-loop times multiplied out), exclusive vs inclusive time,
  and the parallel-work-vs-elapsed-time distinction.
- **Analyzer** — cardinality misestimates, disk spills, hash batches, filter waste,
  nested-loop blowups, lossy bitmaps, stale visibility maps, unlaunched parallel
  workers, temp I/O, JIT and trigger overhead. Ranked by time cost, not rule order.
- **Teaching mode** — plain-English narration of what the plan did and why. Templates,
  not a model: narration can't hallucinate an index.
- **Index advisor** — columns extracted from predicates, ordered equality-first, with
  caveats for function-wrapped columns, pattern operators and implicit casts.
- **Rewrite advisor** — structural anti-patterns found in the SQL itself, using
  `libpg_query` (the real Postgres parser) rather than regex: function-wrapped columns,
  `NOT IN` null semantics, deep `OFFSET`, leading-wildcard `LIKE`, `OR` across columns,
  and scalar subqueries in the select list. Rewrites that change *results* rather than
  just speed say so explicitly.
- **What-if engine** — hypothetical indexes via HypoPG, and `work_mem` /
  planner-GUC changes. Every suggestion re-planned and diffed.
- **Plan diff** — structural tree alignment with access-method change detection,
  surfaced node by node in the UI.
- **Collector agent** — holds the database connection, runs the what-if loop, and
  normalises query text before anything leaves the network.
- **Web UI** — findings, exclusive-time flame graph, plan tree, rewrite advice, a
  settings what-if panel, and the proof loop.

Not yet built: workload ingestion (`pg_stat_statements` / `auto_explain`) and the CI
gate. See [REQUIREMENTS.md](REQUIREMENTS.md).

## Getting started

Requires Node 20+ and a PostgreSQL database.

```bash
npm install
npm run build --workspace @query-not/core
```

Point the agent at a database and start it:

```bash
export QUERYNOT_DATABASE_URL="postgres://readonly_user:pw@host:5432/yourdb"
npm run agent          # http://localhost:5174
npm run web            # http://localhost:5173
```

To enable index what-ifs, install [HypoPG](https://github.com/HypoPG/hypopg) on the
target database:

```sql
CREATE EXTENSION hypopg;
```

Without it everything else still works; the UI shows a `no hypopg` badge and disables
"Prove it" rather than silently offering a broken button.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `QUERYNOT_DATABASE_URL` | `postgres://localhost/postgres` | Target database |
| `QUERYNOT_STATEMENT_TIMEOUT_MS` | `15000` | Hard ceiling on any statement |
| `QUERYNOT_MAX_CONNECTIONS` | `4` | Pool size |
| `QUERYNOT_PORT` | `5174` | Agent HTTP port |

## Safety

`EXPLAIN ANALYZE` **executes the query.** That single fact drives the design, so the
protection is layered rather than resting on any one check:

1. **Statement admission** — one statement, and it must read. Catches
   `WITH gone AS (DELETE … RETURNING *) SELECT * FROM gone`, which begins with `WITH`
   and deletes your table.
2. **`BEGIN READ ONLY`** — Postgres itself refuses the write.
3. **`statement_timeout`** — a runaway query dies on its own.
4. **A read-only role** — your deployment's job. The agent reports whether one is
   actually in place at `/api/health`.

Layer 1 is textual and therefore the weakest; it exists to catch mistakes, not
attackers. Layers 2–4 are what hold, which is why none are optional.

**What a rollback does not undo:** sequence advancement, and side effects from triggers
that reach outside the database.

### Privacy

Query literals carry emails, tokens and names. The agent runs inside your network and
fingerprints query text — stripping literals, numbers, bind parameters and comments —
before anything is stored or shipped. Fingerprinting and PII removal are the same
operation, done once, at the boundary.

## Architecture

```
packages/core     pure analysis engine — no I/O, no database, fully testable
packages/agent    holds the connection, runs plan(sql, world), serves the IR
packages/web      React UI — never talks to Postgres, only to the agent
```

The agent isn't a metrics shipper. The re-plan loop needs a live connection and only
the agent has one, so `plan(sql, world)` executes there and the service orchestrates.
That's what keeps credentials and raw query text inside your network.

## Development

```bash
npm test          # 161 unit tests across core and agent
npm run typecheck
npm run test:e2e  # full stack: seeds, starts both servers, 140 checks, tears down
```

**301 checks in total** — 161 unit, 78 API end-to-end, 62 browser end-to-end.

Core's test fixtures are **real `EXPLAIN` output** captured from a seeded Postgres
(`packages/core/test/fixtures/seed.sql`), not hand-written JSON — including a
before/after pair captured either side of a real HypoPG hypothetical index. Hand-written
JSON tends to agree with whatever the parser already does.

The end-to-end suites go further, because some things are only observable in the real
thing: `e2e/api.e2e.mjs` drives every agent endpoint over HTTP against a live database
(including every refusal path, and a check that nothing was written), and
`e2e/ui.e2e.mjs` drives the UI in a real browser — every flow, plus layout overflow at
three viewports, console errors, whether the webfont actually applied, and measured
colour contrast on the flame graph in both themes.

That last check earned its place: it caught the flame labels rendering at 2.1:1 despite
a palette validated at 9.3:1. The colours were right; an SVG `fill` attribute cannot
resolve `var()`, and a CSS rule was overriding it anyway.

### Typography

`-apple-system` leads the font stack, so Apple devices render SF Pro from the OS.
Everyone else gets [Inter](https://rsms.me/inter/), self-hosted and bundled — no runtime
CDN request, so the app works offline and under a strict CSP.

SF Pro is deliberately *not* vendored: Apple's licence covers UI mockups for
Apple-platform apps and does not permit self-hosting the font on the web. Inter was
designed as an SF-alike and is SIL OFL.

## Prior art

pganalyze, pgMustard, PEV2 / explain.dalibo.com, explain.depesz.com, HypoPG, Dexter.
The gap none of them fully close: proven, workload-aware suggestions inside the
development loop, rather than diagnosis handed to a human who then guesses.
