# query-not

A PostgreSQL query optimiser that doesn't just *show* you a slow plan — it proves what
would fix it.

Paste a query or connect a workload, and query-not finds the bottleneck, proposes a
fix, and then **re-plans the query to prove the fix works** — before you touch
production.

```
plan(sql, world) → IR          world = (schema, statistics, GUCs, params, extensions)
diff(IR, IR)     → change set
```

Everything is a perturbation of that world: add a hypothetical index, raise `work_mem`,
simulate 10x growth, rewrite the SQL — then re-plan and diff. Suggestions arrive with
evidence attached, not vibes.

**Status: ideation.** Nothing is built yet. See [REQUIREMENTS.md](REQUIREMENTS.md) for
the design, the hard problems, and what's still undecided.
