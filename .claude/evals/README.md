# System evals

Runnable checks that keep the agent system and the repo's load-bearing invariants honest. When the same failure happens twice, it becomes an eval here (via the **eval-designer** agent) instead of a memory note nobody reads.

Run all: `node .claude/evals/run.mjs` — the delivery-gate hook requires this after any `.claude/` change.

Format: each `NNN-name.eval.mjs` exports `name` (string) and async `check()` that throws on failure with a message pointing at the offending file. Evals must be fast (<2s), dependency-free, deterministic, and guard **invariants**, not implementations.

Numbering: 0xx = agent-system integrity, 0xx≥030 = repo invariants. Leave gaps for insertion.
