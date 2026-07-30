# The GitHub Action

`querynot ci` packaged as a composite action, so a repository that depends on
Postgres can gate its pull requests on plan regressions without vendoring this
project. Referencing the action checks this repository out on the runner and builds
it there — an `npm ci` and one `tsc` pass over core; the CLI then plans every query
in your query file against a database you provide and compares each plan to your
committed baseline. The job fails when an index a query depended on stops being
used, or when estimated cost rises past the threshold.

The gate only plans. Every statement is a plain `EXPLAIN` inside a read-only
transaction that is always rolled back, so no query is executed and nothing is
written — any role works, including the default `postgres` user of a throwaway
service container.

## Gating pull requests

Your repository carries two files: the query file, a JSON object of name to SQL
(`queries.json` by default), and the committed baseline (`.querynot/baseline.json`).
The database is yours to provide, and a service container seeded by the same
migrations your test suite applies is the usual shape:

```yaml
name: plan-gate
on: pull_request

jobs:
  plans:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: app
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10

    steps:
      - uses: actions/checkout@v4

      # The gate plans against whatever this database looks like, so give it
      # the real schema — apply migrations exactly as your test suite does.
      - name: Apply migrations
        env:
          PGPASSWORD: postgres
        run: psql -h localhost -U postgres -d app -f db/schema.sql

      - uses: jeremainecheong/query-not@main
        with:
          database-url: postgres://postgres:postgres@localhost:5432/app
```

The database needs the schema and its indexes; it does not need data. The baseline
was recorded against the same kind of migrations-seeded database, so the comparison
is like against like, and the case the gate exists for — a migration dropping an
index a hot query depended on — shows up in the plan of an empty table just as it
would in production. Loading representative data and running `ANALYZE` makes the
cost estimates more realistic, but is not required.

`@main` tracks this repository's default branch. Pin a commit SHA if you want the
gate to change only when you choose.

## Recording the baseline

The gate refuses to run without a baseline (exit 2, with a message saying to record
one). The simplest way to produce it is locally, against any database with the right
schema, committed like any other file:

```bash
npx querynot baseline queries.json
git add .querynot/baseline.json
```

The same works continuously: a second workflow on the default branch, identical to
the gating one up to the action step — same service container, same migrations, plus
`permissions: contents: write` on the job — where the action records instead of
checks and the workflow commits the result:

```yaml
      - uses: jeremainecheong/query-not@main
        with:
          database-url: postgres://postgres:postgres@localhost:5432/app
          record-baseline: 'true'

      - name: Commit the baseline when it changed
        run: |
          git add .querynot/baseline.json
          if ! git diff --cached --quiet; then
            git config user.name "github-actions[bot]"
            git config user.email "github-actions[bot]@users.noreply.github.com"
            git commit -m "chore: re-record plan baseline"
            git push
          fi
```

When a pull request changes a plan on purpose — a new index, a rewritten query —
the gate still fails, and its failure message says what to do: re-record the
baseline and commit it in the same PR. The recording workflow on main then keeps
the committed copy exact after merge.

## Inputs

| Input | Default | Purpose |
|---|---|---|
| `database-url` | required | Connection string for the Postgres the queries are planned against |
| `queries` | `queries.json` | The query file — a JSON object of `{ "name": "SELECT …" }` — relative to the repository root |
| `baseline` | `.querynot/baseline.json` | The committed baseline, relative to the repository root |
| `max-cost-increase` | `0.20` | Fractional rise in estimated cost tolerated before failing (`0.20` = 20%) |
| `record-baseline` | `false` | When `true`, record the baseline instead of checking against it |

The job fails with the CLI's own exit code: 1 for a regression, 2 for a missing
baseline, an unreadable query file, or a database error. A query present in the
file but absent from the baseline is reported as new and not checked; a query
removed from the file stops being checked, and its baseline entry lingers until
the next recording prunes it.

## Limitations

The plans are the CI database's plans. Baselines record plan *shape*, not timing,
because a committed baseline gets compared on someone else's machine — and the same
honesty applies to the database itself: the gate plans against whatever database it
is pointed at, which is fine for a CI Postgres seeded from migrations and not a
substitute for production statistics. A failure here is a real regression against
that schema; a pass is not proof the query is fine in production, where table
sizes, statistics and settings differ.

Estimated cost is the planner's number, not a measurement. The gate never executes
a query — that is what makes it safe to point at any database — so it cannot see
runtime effects like disk spills or cache behaviour. Use the analyser against a
real workload for those.

The action runs `actions/setup-node` with Node 22, and as with any composite
action, that installation stays on the job's PATH for later steps.
