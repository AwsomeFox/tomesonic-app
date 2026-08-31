# Operations log

One line per incident. Format is enforced socially by context-librarian: keep it operational — date, failure, root cause, system patch, eval, next. No diary entries. Entries whose patch+eval landed >1 month ago without recurrence get pruned.

| date | failure | root cause | system patch | eval | next |
|---|---|---|---|---|---|
| 2026-07-07 | No assistant behavior was enforced by anything except CI; instructions lived in prose only | No hooks/evals existed — every rule was wishful thinking in-chat | Agent system: hooks (risk-guard, evidence-logger, delivery-gate, budget-governor, handoff), 9 agent contracts, eval harness | 010, 020 | Watch for hook false positives; log them here |
