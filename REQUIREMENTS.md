# query-not — Requirements & Design

A PostgreSQL query optimiser that doesn't just *show* you a slow plan — it proves what
would fix it.

Status: **Phases 1–2 built**, Phases 3–5 not started. This document captures decisions
made, problems identified, and questions still open. See §8 for what exists today.

---

## 1. Thesis

Plan visualisers are a solved and crowded space (pgMustard, PEV2, explain.depesz.com,
pganalyze). Building a nicer plan viewer adds nothing.

The unsolved part is the **loop**. A plan tells you what happened; it doesn't tell you
what to do, and nothing verifies that the advice works. Today the workflow is: read a
plan, guess at an index, build it, wait, measure, repeat. Every step is expensive and
the guess is usually a human's pattern-match.

query-not closes that loop. Every suggestion it makes is re-planned and shown as a
before/after diff before you touch production.

**The product is a what-if machine, not a plan viewer.**

---

## 2. Core abstraction

Everything the tool does reduces to one primitive:

```
plan(sql, world) → IR          world = (schema, statistics, GUCs, params, extensions)
diff(IR, IR)     → change set
```

Every feature is a perturbation of one input, followed by a re-plan and a diff:

| Feature         | Perturbs                                      | Then |
|-----------------|-----------------------------------------------|------|
| What-if index   | `world.schema` (hypothetical index)           | re-plan, diff |
| What-if config  | `world.GUCs` (`work_mem`, `random_page_cost`) | re-plan, diff |
| What-if growth  | `world.statistics` (simulated row counts)     | re-plan, diff, find the flip point |
| Rewrite advisor | `sql`                                         | re-plan, diff, check equivalence |
| CI gate         | `world.schema` (the PR's migrations)          | re-plan, diff vs baseline, assert |
| Teaching mode   | nothing                                       | narrate the IR and the diff |

This is not four projects. It is one engine with four surfaces.

**Consequence for sequencing:** the plan IR and the tree-diff algorithm are the
foundation. Everything else is a thin layer on top. Build and validate them first.

---

## 3. Scope decisions

| Decision | Choice | Why |
|---|---|---|
| Data access | **Live connection** | What-if, hypothetical indexes and re-planning are impossible offline. This is where the value is. |
| Network position | **Customer-run collector agent** | The customer connects to their own database, inside their own network. We never hold a credential. See §6.2. |
| Unit of work | **Whole workload** | The 4ms query that runs 2M times/day is the real problem, and nobody pastes *that* into a paste box. |
| Interface | **Web app** | Best canvas for flame graphs, plan diffs and interactive what-ifs. |
| Engine | **PostgreSQL first** | Richest `EXPLAIN` output, JSON format, HypoPG exists. Other engines behind an IR boundary. |

### Included

- Workload ingestion and ranking
- Plan visualisation + teaching mode
- What-if engine (indexes, config, data growth)
- Rewrite advisor with empirical equivalence checking
- CI / regression gate

### Non-goals (for now)

- Non-Postgres engines. The IR must not assume Postgres, but no adapters get written yet.
- Automatic remediation. We propose and prove; a human applies. Auto-creating indexes on
  someone's production database is not a v1 feature and possibly not ever.
- Being an APM. We explain queries, not request traces. N+1 detection is in scope only
  as a query-pattern signal.

---

## 4. The plan IR

Parsed from `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`, normalised into an
engine-neutral tree. Per node:

- **Identity** — node type, target relation, index used, output columns.
  This tuple is the matching key for diffing.
- **Cardinality** — estimated rows, actual rows, `loops`. Store the misestimate
  ratio `max(est/act, act/est)` as a first-class field; it is the highest-value
  diagnostic in the entire plan.
- **Time** — inclusive and **exclusive** (self) time. Exclusive time is what the
  flame graph is weighted by.
- **Waste** — `Rows Removed by Filter`, `Rows Removed by Join Filter`. Work performed
  and thrown away, i.e. a missing index or a predicate that should have been pushed down.
- **Spills** — `Sort Method: external merge`, hash join `Batches > 1`. These are
  `work_mem` problems wearing a query problem's clothes.
- **Buffers** — shared hit / read / dirtied / written. Distinguishes "slow because
  cold cache" from "slow because the query is bad", which timing alone conceals.

### The `loops` trap

Postgres reports `actual time` **per loop**. A node showing `0.03ms` executed 90,000
times cost 2.7 seconds, and this is misread constantly. The IR stores both per-loop and
multiplied-out totals, and the UI shows the total by default.

---

## 5. Features

### F1 — Workload ingestion

Two sources, because neither is sufficient alone.

**`pg_stat_statements` → the ranking.** Which queries matter. Poll on an interval and
delta the cumulative counters.

- Sort by **total time**, not mean. Also surface **stddev**: high variance is a
  plan-instability signal worth investigating on its own.
- Handle counter resets (`pg_stat_statements_reset()`, server restart) — a negative
  delta means reset, not negative work.
- Handle eviction. Once `pg_stat_statements.max` (default 5000) is reached, entries are
  evicted; a query vanishing from the view does not mean it stopped running.

**`auto_explain` → the plans.** Real plans from real production traffic, with real
parameters, at zero execution risk from us.

```
auto_explain.log_min_duration = <threshold>
auto_explain.log_analyze      = on
auto_explain.log_buffers      = on
auto_explain.log_format       = json
auto_explain.log_parameter_max_length = <n>   -- PG 16+, logs bind params
```

This is the primary plan source for the observation path. We only synthesise parameters
for the what-if path (see §6.1).

**Fingerprinting.** Normalise literals to placeholders so executions group and trend.
Normalisation is also the PII boundary — see §7.

### F2 — Visualisation & teaching mode

The plan tree is the least useful rendering. What actually finds the bug:

- **Icicle/flame graph weighted by exclusive time** — answers "where did the 4 seconds
  go" instantly.
- **Nodes coloured by misestimate ratio** — the planner's wrong assumption lights up
  before you have read a single word.
- **Edge thickness by rows flowing** — makes row explosions visible as shape.
- Badges for spills, filter waste, and high `loops`.

**Teaching mode.** Most developers can't read a plan, which is why they don't. Plain
English narration:

> "Postgres chose a Nested Loop because it expected 12 rows from the inner side. It got
> 340,000. That 28,000x misestimate is why this took 8 seconds — and it traces back to
> stale statistics on `orders`, last analysed 14 days ago."

This is where an LLM earns its place: **narration and explanation, never judgement.**
Judgement comes from re-planning, which is checkable. A model that guesses at indexes
is exactly the failure mode this project exists to fix.

### F3 — What-if engine (the differentiator)

Every suggestion ships with proof attached. Not *"consider adding an index"* but
*"add this index → Seq Scan (cost 48,000) becomes Index Scan (cost 8.2) → here is the
before/after tree."*

**Hypothetical indexes** via HypoPG: create an index with no build cost, re-plan,
diff. Caveat: hypothetical indexes work with plain `EXPLAIN` only, never
`EXPLAIN ANALYZE` — the index does not physically exist. So we get plan-shape proof,
not timing proof, and the UI must say so honestly.

**Config what-ifs**: set the GUC in-session, re-plan. `work_mem` large enough to stop
a hash join spilling to 12 batches is a one-line fix that looks like a query rewrite
problem.

**Data-growth simulation**: perturb the statistics, sweep table size, and find the
point where the plan flips from Index Scan to Seq Scan. *Nobody shows you the cliff
you are six months from driving off.* Rendered as a cost curve with the flip point
marked.

**Workload-level index advice.** Per-query index advice is actively harmful — it
produces index bloat, and every index taxes every write. Reasoning across the whole
workload:

- Merge suggestions — three proposed indexes collapse into one composite;
  `(a,b,c)` subsumes `(a)` and `(a,b)`.
- **Write amplification** — "this index saves 200ms on query X, which runs 400/day,
  and costs ~8% on the insert path, which runs 200,000/day." Nobody shows the cost side.
- **Unused index detection** via `pg_stat_user_indexes.idx_scan`. Drops are as valuable
  as adds and considerably safer to recommend.
- Redundant-prefix detection.

**Statistics hygiene.** Many misestimates are not missing indexes at all: stale
`last_analyze`, wrong `n_distinct`, correlated columns needing `CREATE STATISTICS`
(`ndistinct` / `dependencies` / `mcv`), or `default_statistics_target` set too low.
Check these before recommending an index — the fix is cheaper and the index may be
unnecessary once the planner can see straight.

### F4 — Rewrite advisor

Detected from the **AST**, not the plan. Use `libpg_query` (the actual Postgres parser
as a library) — hand-rolling SQL parsing is a trap that swallows projects.

| Anti-pattern | Rewrite |
|---|---|
| `WHERE date(created_at) = …` | Function on column kills the index → range predicate or expression index |
| Implicit cast (`varchar` column vs `int` param) | Index silently unused |
| `NOT IN (subquery)` | `NOT EXISTS` — **and flag the NULL semantics change** |
| Correlated subquery in `SELECT` | `LATERAL` join |
| `OFFSET 10000` | Keyset pagination |
| `SELECT *` | Column pruning — may enable an index-only scan |
| `OR` across columns | `UNION ALL` |

**The differentiator is verification.** Proving semantic equivalence of two SQL queries
is undecidable in general, so we do it empirically: run both against a sample, compare
result-set hashes. Every rewrite ships with an honest confidence label —
*"verified equivalent on 10k sampled rows"* or *"⚠️ changes NULL handling"* — rather
than a confident guess. A rewrite advisor that is silently wrong is worse than none.

### F5 — CI / regression gate

The feature teams actually pay for, and a small increment over the engine.

On a pull request:

1. Extract queries — from ORM call sites, a `queries/` directory, tests, or the
   recorded workload.
2. Plan them against a shadow database carrying production statistics (§6.3).
3. Diff against stored baseline plan fingerprints.
4. Fail on: scan-type regression, cost increase beyond threshold, a new sequential scan
   on a large table, or a migration dropping an index that hot queries depend on.

Migration analysis is its own check: parse the migration for `DROP INDEX`, column type
changes, and new columns on hot filter paths.

---

## 6. Hard problems

Listed because they are the ones that decide whether this works.

### 6.1 Parameters — the hardest problem

`pg_stat_statements` gives normalised SQL with `$1` placeholders and **no parameter
values**. You cannot `EXPLAIN` a query whose parameters you do not have, and the plan
frequently depends entirely on them: a common value yields a sequential scan, a rare
value an index scan.

Mitigations, in order of preference:

1. **`auto_explain` with `log_parameter_max_length`** (PG 16+) — real params from real
   traffic. Preferred wherever available.
2. **Synthesis from `pg_stats`** — draw from `most_common_vals` and `histogram_bounds`.
   Plan under **several** parameter sets, not one.
3. Surface the disagreement as a feature: when parameter sets produce different plan
   shapes, that *is* the finding. Parameter-sensitive plans are invisible in every tool
   we know of.

### 6.2 Credentials and network position — DECIDED: collector agent

A hosted web app holding customer production database credentials is a serious
liability and a real adoption blocker. We are not doing that.

Instead: a **collector agent** the customer runs inside their own network. The customer
connects to their own database. The agent holds the credential, connects locally, and
ships plans and normalised statistics outward. We never see a credential or a row of
customer data.

Consequences to design around:

- **Normalisation happens agent-side**, before anything leaves the network. This is the
  strongest possible privacy position (§7) and it comes free with this architecture.
- **What-ifs execute agent-side too.** The re-plan loop needs a live connection, so the
  agent is not merely a shipper — it is where `plan(sql, world)` actually runs. The web
  app orchestrates and renders; the agent computes. Design the agent/service boundary as
  a request/response protocol over the IR, not as a one-way metrics firehose.
- **Costs a deployment story.** Container image, config, upgrade path, and a way to tell
  whether someone's agent is alive and healthy. Worth it.
- **Constrains the CI gate.** CI cannot reach production, so the shadow database (§6.3)
  is not an optimisation — it is load-bearing for F5.

### 6.3 Safety of execution

`EXPLAIN ANALYZE` **executes the query**. Plain `EXPLAIN` does not. Anything that
executes needs:

- A read-only role and `SET TRANSACTION READ ONLY`.
- A hard `statement_timeout`.
- For DML: `BEGIN; EXPLAIN ANALYZE …; ROLLBACK;`. Note that sequences do not roll back,
  and triggers with external side effects still fire.
- Preference for a replica over the primary — while remembering that replica plans can
  differ (different settings, different statistics freshness).

**Shadow database.** Clone schema plus *statistics*, with no data. PG 18+ can dump and
restore optimizer statistics directly; below that it requires manual `pg_statistic`
manipulation and is fiddly. Result: production-realistic plans with zero production
data and zero risk. This is the answer to "I am not pointing your tool at my production
database," and it is what makes the CI gate possible at all — CI cannot reach prod.

### 6.4 What we plan is not always what production ran

Prepared statements can switch to a **generic plan** after roughly five executions
(`plan_cache_mode`). Our re-plan produces a custom plan. These can differ materially.
`auto_explain` shows the truth; our what-ifs show a hypothesis. Label them differently.

### 6.5 HypoPG is an installation ask

The what-if engine needs HypoPG on the target database, which is friction — and on
managed providers it may simply be unavailable. The shadow database sidesteps this
entirely (we control what is installed there), which is another argument for building
it early rather than treating it as a CI-only concern.

---

## 7. Privacy

Query **text** contains literals: emails, names, tokens, identifiers. Storing plans
means storing that.

- Normalise at ingestion, before persistence. Fingerprinting and PII stripping are the
  same operation — do it once, at the boundary.
- Retain raw parameter values only where explicitly enabled, only for the retention
  window needed, and never by default.
- The agent model (§6.2) means normalisation happens inside the customer's network,
  before anything leaves it. Raw query text never crosses the boundary.

---

## 8. Sequencing

Ordered so each phase is independently useful and de-risks the next.

**Phase 1 — the spine. ✅ Built.** Read-only connection, plan IR, flame graph,
misestimate heat, teaching mode. Single query.

**Phase 2 — the differentiator. ✅ Built.** Tree diff + what-if (HypoPG indexes, GUC
changes). Suggestions are proven rather than guessed.

**Phase 3 — workload.** `pg_stat_statements` + `auto_explain` ingestion, ranking,
fingerprinting, trends. Plus workload-level index consolidation and write-cost analysis.
*Query fingerprinting already exists in the agent (it is the privacy boundary), so the
ingestion work starts from a normalised key rather than raw text.*

**Phase 4 — rewrite advisor. ✅ Built.** `libpg_query` AST analysis over the query text.
*Empirical equivalence checking is still outstanding — see §9. What ships instead is an
explicit `semanticChange` field on every rewrite whose result set can differ, which is
the honest position until sampling exists to verify it.*

**Phase 5 — CI gate.** Shadow database, baselines, PR checks, migration analysis.

Teaching mode rode along with Phase 1 rather than being its own phase — it is narration
over an IR we already have.

### What Phases 1–2 delivered

| Piece | Where |
|---|---|
| Plan IR + `EXPLAIN` parser | `packages/core/src/parse.ts` |
| Findings engine (13 rules) | `packages/core/src/analyze.ts` |
| Index advisor + predicate extraction | `packages/core/src/{analyze,predicates}.ts` |
| Teaching-mode narrator | `packages/core/src/narrate.ts` |
| Structural plan diff | `packages/core/src/diff.ts` |
| Flame layout (exclusive time) | `packages/core/src/flame.ts` |
| Admission control + fingerprinting | `packages/agent/src/safety.ts` |
| Connection guard (READ ONLY, timeout, rollback) | `packages/agent/src/db.ts` |
| What-if engine (HypoPG + GUCs) | `packages/agent/src/explain.ts` |
| Rewrite advisor (AST) | `packages/agent/src/rewrite.ts` |
| Web UI | `packages/web/` |
| End-to-end suites | `e2e/` |

**301 checks** — 161 unit, 78 API end-to-end, 62 browser end-to-end. Core's fixtures are
real `EXPLAIN` output from a seeded Postgres, including a before/after pair captured
either side of a live HypoPG hypothetical index.

**Why the rewrite advisor lives in the agent, not core.** Core is pure, engine-neutral
and imported directly by the browser. `libpg_query` is a wasm build of the actual
Postgres parser — Postgres-specific by definition, and with no business in a browser
bundle. The boundary holds: core analyses *plans*, the agent analyses *queries*.

### Corrections found while building

Two bugs worth recording, because both were in *user-facing numbers* rather than in
logic — the class of error that is hardest to notice and most damaging to trust.

1. **Parallel plans reported shares above 100%.** Per-worker times summed to more than
   wall-clock, so dividing node time by elapsed time produced "202% of runtime". Share
   calculations now divide by total *work* (`QueryPlan.totalWorkMs`), and the narration
   explains the distinction rather than hiding it.

2. **`date` was both a type name and a function name.** Because both lived in one
   reserved-word list, `WHERE date(created_at) = …` was not recognised as a
   function-wrapped column — so an index that cannot work would have shipped as
   high-confidence advice. Type names and non-function keywords are now separate lists.

3. **Flame-graph labels rendered at 2.1:1 against a palette validated at 9.3:1.** The
   colours were correct; the wiring was not. An SVG `fill` *attribute* cannot resolve
   `var()`, and a blanket `fill: #fff` in the stylesheet was overriding it regardless.
   Only a contrast measurement taken in a real browser could catch this — static palette
   validation had already passed. It is why `e2e/ui.e2e.mjs` computes contrast from
   rendered pixels rather than trusting the tokens.

A pattern worth naming: all three were in *presentation*, not logic, and all three would
have read as authoritative. For a tool whose entire proposition is "trust this because
it was verified", that class of bug is the expensive one.

---

## 9. Open decisions

1. **Agent/service protocol shape** — the agent must serve interactive what-if requests,
   not just push metrics (§6.2). Long-poll, websocket, or queue?
2. **Where the shadow database lives** — ephemeral per-CI-run, or long-lived per
   project? Affects statistics freshness and cost. Also: does the agent build it, since
   only the agent can see production statistics?
3. **Baseline storage for CI** — committed to the repo (reviewable in diffs, noisy)
   or held service-side (clean, invisible)?
4. **Equivalence-check sampling strategy** — how many rows, and how are they chosen so
   that edge cases like NULL handling are actually exercised rather than missed? Random
   sampling will systematically miss exactly the cases the riskiest rewrites turn on:
   `NOT IN` → `NOT EXISTS` only differs when the subquery yields a NULL. Sampling has to
   be adversarial against the predicate, not uniform. Until it exists, the rewrite
   advisor states the semantic difference rather than claiming equivalence.
5. **Multi-plan presentation** — when a query has several plan shapes across parameter
   sets, what is the primary view?

---

## 10. Prior art

Worth studying rather than ignoring: pganalyze (workload + advisor, agent model),
pgMustard (per-node scoring and advice quality), PEV2 / explain.dalibo.com
(visualisation), explain.depesz.com (per-node statistics presentation), HypoPG
(hypothetical indexes), Dexter (automated index selection).

The gap none of them fully close: **proven, workload-aware suggestions inside the
development loop**, rather than diagnosis handed to a human who then guesses.
