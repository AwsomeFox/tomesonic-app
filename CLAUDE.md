# TomeSonic — operator core

React Native (Expo SDK 57, RN 0.86, New Architecture) AudiobookShelf client. All app code is in `native/`; repo root is docs/CI/store assets. Project knowledge: `.github/copilot-instructions.md` (invariants) and `native/TESTING.md` (test rules). Full agent-system reference: `docs/agent-system.md`.

## Commands

```bash
cd native && npm run typecheck && npm test   # the bar for "done" (delivery-gate enforces this)
node .claude/evals/run.mjs                   # required after any .claude/ change
```

## Delegation & model routing

Orchestrate from the main session (launch: `claude --agent chief-operator`). Route by weight, not habit:

| Tier | Use for | Agents |
|---|---|---|
| top / `inherit` (Fable-class when available) | audits, root-cause analysis, architecture, adversarial review, improvement loops | adversarial-critic, improvement-analyst |
| opus | the disciplined chief itself | chief-operator |
| sonnet | bounded implementation & verification | builder, qa-engineer, system-fixer, eval-designer |
| haiku | small bounded lookups & housekeeping | research-scout, context-librarian |

Every delegation names goal, scope, output limit, and required evidence — contracts live in `.claude/agents/`. Don't preload broad context into workers; give each the few files it needs.

## Memory rules

- Recurring failure → one line in `.claude/memory/operations-log.md` (`date | failure | root cause | patch | eval | next`) **and** an eval if checkable. A memory note without an enforcement point is not a fix.
- `.claude/memory/handoff-latest.md` is auto-written before compaction — read it when the session-audit hook says it exists.
- Keep this file short. New rules go here only if no hook or eval can enforce them instead.
