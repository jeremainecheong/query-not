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

## Demo

[![query-not — narrated demo](docs/demo/poster.png)](docs/demo/query-not-demo.mp4)

**[▶ Watch the demo](docs/demo/query-not-demo.mp4)** — 4 minutes, narrated and
captioned ([subtitles](docs/demo/query-not-demo.srt)). Everything on screen is real,
measured output against a seeded 4-million-row database: the hero query's
87,748 → 422 index proof, the plan graph with its ringed hotspot, the operation
reference, the generated `LEFT JOIN` rewrite proven with `customers_pkey` cited
from the catalog and 19,999 rows compared — and the generated rewrite the tool
itself tells you not to apply. The CI gate fails a build on camera.

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
- **Generated rewrites, proven** — for five kinds, the advisor writes the optimised
  statement itself: `NOT IN (SELECT …)` → `NOT EXISTS`, `NOT IN (list)` → a VALUES
  anti-join, `date(col) = 'D'` → a half-open range an index can serve, `WHERE a OR b`
  → `UNION ALL` arms guarded with `AND (earlier arm) IS NOT TRUE` so they partition
  the result exactly, and a correlated scalar subquery in the select list — the hidden
  N+1 — → a `LEFT JOIN`. "Prove it" then establishes the schema facts that make the
  rewrite safe (`attnotnull` for the NOT IN pair; for the subquery-to-join, a unique
  index over the correlated columns — the fact that makes fan-out impossible — cited
  by name from `pg_index`), re-plans both forms and diffs them, and compares the
  complete result sets in a single statement. A failed fact downgrades the whole
  thing to advice with nothing executed; `LIMIT` refuses row verification outright,
  because which rows survive a limit depends on tie-breaking and the rewrite changes
  the plan doing the breaking. **Proven** means all three legs held — and the verdict
  sentence cites them. The splice-based kinds validate by reparse-and-containment;
  the restructuring kinds validate harder: the expected parse tree is built from the
  original tree by the same structural operation, and the candidate must parse to
  exactly it. On the seeded database the subquery-to-join proves with a 99% estimated
  cost drop, while the unindexed OR split honestly reports **regressed — do not
  apply** with its rows still matching: the tool argues from evidence either way.
- **What-if engine** — hypothetical indexes via HypoPG, and `work_mem` /
  planner-GUC changes. Every suggestion re-planned and diffed.
- **Extended-statistics advisor** — when a node underestimates badly and its
  predicate is an equality conjunction over several columns of one table (the
  correlated-columns case per-column statistics cannot represent), the advisor
  suggests `CREATE STATISTICS (dependencies, ndistinct)` with the measured
  ratio cited, confirms the columns against the SQL's AST, and reports whether
  a covering object already exists — including the exists-but-never-ANALYZEd
  state read from `pg_stats_ext`. With an opt-in sandbox
  (`QUERYNOT_SANDBOX_URL`) "Prove it" runs the DDL and an `ANALYZE` inside a
  single rolled-back transaction and diffs estimate accuracy before and after:
  on the seeded database, 2,036 → ~10,100 estimated against 10,000 actual, with
  the functional dependency cited by degree from `pg_stats_ext.dependencies`.
  Nothing persists. Without the sandbox the suggestion stands as advice with
  exact DDL.
- **Parameter sensitivity** — the same query planned along the column's own statistics:
  constants drawn from the `pg_stats` histogram (p10/p50/p90 positions) or the
  most_common_vals list, each re-planned with plain EXPLAIN, and the flip boundary
  reported as a bracket between sweep points — planner estimates by declaration, with
  the tool refusing (and saying why, citing `pg_stats`) when the statistics cannot
  support a sweep.
- **Plan diff** — structural tree alignment with access-method change detection,
  surfaced node by node in the UI.
- **Collector agent** — holds the database connection, runs the what-if loop, and
  normalises query text before anything leaves the network.
- **Plan history** — every run is recorded and keyed by fingerprint, so the diff engine
  can answer *"when did this get slower, and what changed?"* Regression detection keys
  off plan structure and planner cost, never wall-clock, because timing varies run to
  run and a history that cries wolf is worse than none.
- **Saved queries and shareable links** — name a query to keep its history; every
  analysis gets a URL you can paste to a colleague.
- **Operation reference** — every plan operation Postgres can emit, illustrated: what it
  does, why the planner picks it, and how it goes wrong. Rendered from the same glossary
  the narrator reads, so the reference and the explanation beside a real plan cannot
  drift apart.
- **Web UI** — a landing page, a query index, per-query history, saved queries, the
  reference, and the analysis view with its plan graph and proof loop.

- **Workload ingestion** — `pg_stat_statements`, delta'd between snapshots and ranked by
  **total** time. The 4ms query running two million times a day costs more than the
  eight-second report, and only one of those shows up in a slow-query log. Handles
  counter resets and entry eviction, both of which produce plausible nonsense if ignored.
- **CI gate** — `querynot ci` plans your queries against a committed baseline and fails
  the build when an index stops being used or cost jumps. Baselines record plan *shape*,
  not timing, because a committed baseline gets compared on someone else's machine.
- **Decisions** — every proven change is recorded automatically with its verdict and
  numbers, plus whether it was ever actually shipped.
- **Drop-safety proofs** — every user index listed with its size, definition and
  `idx_scan` count, each sentence carrying the counter's blind spots (resets, replica
  reads, constraint enforcement); indexes that enforce semantics — primary keys,
  unique and exclusion constraints, replica identities, FK-referenced — are flagged
  not-droppable-for-performance and refused outright. "Prove drop" hides the index
  with hypopg 1.4's `hypopg_hide_index` in one session, re-plans every query the
  agent knows about (recorded analyses plus admissible `pg_stat_statements` entries,
  each re-admitted, capped and fully enumerated), and diffs each plan. A load-bearing
  index comes back **regressed — do not drop** with the collapsing query and its cost
  pair; a quiet one is **safe to drop against these queries** — never "safe", full
  stop, because queries the agent has not seen are not covered and the note says so.

Every phase in [REQUIREMENTS.md](REQUIREMENTS.md) is now built.

## Getting started

### Docker — one process

```bash
docker build -t query-not .
docker run -p 5174:5174 \
  -e QUERYNOT_DATABASE_URL=postgres://readonly:pw@host:5432/db \
  -v querynot-data:/data \
  query-not
```

The agent serves the UI and the API on one port. History lives on the volume; without
it a redeploy loses every baseline.

### From source

Requires Node 22+ (for built-in `node:sqlite` and TypeScript stripping) and PostgreSQL.

```bash
npm install
npm run build --workspace @query-not/core

export QUERYNOT_DATABASE_URL="postgres://readonly_user:pw@host:5432/yourdb"
npm run agent          # http://localhost:5174
npm run web            # http://localhost:5173 (dev server, hot reload)
```

Build the UI and the agent serves it too — one port, no second process.

### Command line

```bash
npx querynot analyse query.sql --analyze     # findings in the terminal
npx querynot rewrite query.sql               # structural advice, no database needed
npx querynot baseline queries.json           # record plan baselines
npx querynot ci queries.json                 # fail the build on a plan regression
```

The gate catches the case that matters — a migration dropping an index a hot query
depended on:

```
  ✗ items_by_order
    no longer uses Index Scan on order_items via order_items_order_id_idx
    estimated cost rose 96321% (11 → 11050)
```

To enable index what-ifs, install [HypoPG](https://github.com/HypoPG/hypopg) on the
target database:

```sql
CREATE EXTENSION hypopg;
```

Without it everything else still works; the UI shows a `no hypopg` badge and disables
"Prove it" rather than silently offering a broken button.

### GitHub Action

The gate is also packaged as a reusable action, so a repository can gate its pull
requests on plan regressions with one step:

```yaml
- uses: jeremainecheong/query-not@main
  with:
    database-url: postgres://postgres:postgres@localhost:5432/app
```

[docs/github-action.md](docs/github-action.md) has the full setup — the service
container, recording the baseline, and what the gate does and does not prove.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `QUERYNOT_DATABASE_URL` | `postgres://localhost/postgres` | Target database |
| `QUERYNOT_SANDBOX_URL` | unset | Opt-in DDL sandbox for statistics proofs — a **disposable** copy, never production |
| `QUERYNOT_STATEMENT_TIMEOUT_MS` | `15000` | Hard ceiling on any statement |
| `QUERYNOT_MAX_CONNECTIONS` | `4` | Pool size |
| `QUERYNOT_PORT` | `5174` | Agent HTTP port |
| `QUERYNOT_STORE_PATH` | `./.querynot/store.db` | Where history lives |

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

### The statistics sandbox is the one deliberate exception

`CREATE STATISTICS` cannot be tested hypothetically, so proving one needs real
DDL — which is exactly what the main connection must never be able to run.
Setting `QUERYNOT_SANDBOX_URL` opts into a second connection whose transactions
are **read-write by necessity** (DDL forbids `BEGIN READ ONLY`) and always
rolled back: `CREATE STATISTICS` → `ANALYZE` → re-`EXPLAIN` → `ROLLBACK`, in
one transaction, on one connection. Three things follow, and the proof note
states them too: the analysed query runs there without the read-only-transaction
backstop (admission control, the statement timeout and the unconditional
rollback still apply); the in-transaction `ANALYZE` holds a
`ShareUpdateExclusive` lock on the table until the rollback; and sequences and
externally-visible trigger effects still do not roll back. The contract is
therefore that the sandbox is **disposable** — a copy, or a dev database whose
locks and resampled statistics nobody will miss — and never production. The
sandbox role must own the target tables (`CREATE STATISTICS` and
in-transaction `ANALYZE` both require ownership; PG16's `MAINTAIN` privilege
covers `ANALYZE` only).

### Privacy

Query literals carry emails, tokens and names. The agent runs inside your network and
fingerprints query text — stripping literals, numbers, bind parameters and comments —
before anything is stored or shipped. Fingerprinting and PII removal are the same
operation, done once, at the boundary.

## Architecture

```
packages/core     pure analysis engine — no I/O, no database, fully testable
packages/agent    holds the connection, runs plan(sql, world), serves the IR, owns the store
packages/web      React UI — never talks to Postgres, only to the agent
```

The agent isn't a metrics shipper. The re-plan loop needs a live connection and only
the agent has one, so `plan(sql, world)` executes there and the service orchestrates.
That's what keeps credentials and raw query text inside your network.

### No accounts, on purpose

query-not is single-tenant: one team, one agent, inside one network. Whoever can reach
the agent is already authorised by the network, so a login screen would add a user
table, sessions and password reset while providing no access control that does not
already exist.

That placement is also what keeps the privacy story intact. History lives in a SQLite
file beside the agent (`node:sqlite`, no dependency), so raw SQL never crosses a network
and never needs redacting before storage. The fingerprint is still computed — but as an
*identity* key, the thing that says "this is the same query as last Tuesday", rather
than as redaction.

The store is **never the customer's database**. The agent connects to that read-only,
and writing its own tables there would break the guarantee the whole safety design
rests on.

| Variable | Default | Purpose |
|---|---|---|
| `QUERYNOT_STORE_PATH` | `./.querynot/store.db` | Where history lives |

## Development

```bash
npm test          # 317 unit tests across core and agent
npm run typecheck
npm run test:e2e  # full stack, cold: 476 checks plus a production-bundle run
```

**793 checks in total** — 317 unit, 152 API end-to-end, 162 browser end-to-end, and the
whole browser suite again against the production bundle served by the agent. The dev
server and the built artifact are different things; verifying only the first ships a
build nobody ran.

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

## Pages

| Path | What it is |
|---|---|
| `/` | Landing — what the tool does, where to go, recent runs |
| `/analyse` | The composer. Paste a query, get the analysis |
| `/a/:slug` | A recorded analysis. This is the shareable link |
| `/queries` | Every query seen, grouped by fingerprint, plan changes first |
| `/history/:fingerprint` | One query's plan history, with the points where it changed |
| `/saved` | Named queries |
| `/reference` | Every plan operation, illustrated |

Routing is a ~120-line History-API router with no dependency. The three things a
hand-rolled router usually gets wrong — back button, deep links, refresh — each have a
browser test.

## Visualising a plan

The Hotspots view answers two questions at once, because in practice they are the same
question:

- **The graph** draws the plan as a node-link diagram with rows flowing upward, leaves
  at the bottom. **Edge thickness is row volume**, so a fat edge narrowing to a thin one
  is visible waste — 388,000 rows into a join, 15 out. The slowest operation is ringed
  and labelled `HOTSPOT` rather than left to inference.
- **Slowest operations** ranks every node by self time, descending.

The ranked list exists because a flame graph is a *bad* answer to "which operation is
slowest": in a deep plan every ancestor spans the full width, so five different nodes
all render as full-width bars and the picture reads as "everything is equal". The flame
graph is still there, under the Plan tab, where nesting is what you actually want.

### Typography

The interface is set in SF on Apple devices and [Inter](https://rsms.me/inter/)
everywhere else — and nothing Apple-made ships in the repo. `-apple-system` at the
front of the stack renders genuine SF Pro straight from the OS, which Apple's licence
permits because nothing is redistributed; Inter (SIL OFL 1.1, licence vendored at
`packages/web/src/fonts/LICENSE.txt`) is the single variable `InterVariable.woff2`
and covers every other platform. Mono is a pure system stack — `ui-monospace`
falling through to SF Mono, Menlo, Consolas or DejaVu — so no mono font is vendored
at all.

## Prior art

pganalyze, pgMustard, PEV2 / explain.dalibo.com, explain.depesz.com, HypoPG, Dexter.
The gap none of them fully close: proven, workload-aware suggestions inside the
development loop, rather than diagnosis handed to a human who then guesses.
