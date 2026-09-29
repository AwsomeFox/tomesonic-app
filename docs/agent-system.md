# TomeSonic agent system

The Claude Code operating system for this repo: who does what, and — the question that matters — **which file enforces each behavior tomorrow**. If a behavior's answer is "nowhere", it's wishful thinking living in someone's chat history, and it doesn't belong in this doc.

## The audit that motivated this (2026-07-07, pre-existing state)

Reviewed as a ruthless outsider:

- **No `.claude/` directory existed.** No agents, no hooks, no evals, no memory. Nothing any session did carried over to the next one.
- `native/CLAUDE.md` was one line pointing at `native/AGENTS.md`, which was two lines ("Expo has changed, read the docs").
- The real project knowledge lived in `.github/copilot-instructions.md` — good content (progress-sync invariants, prebuild force-add rule, patch-package warning), but **nothing enforced any of it**. An assistant could edit `jest.setup.ts`, skip tests, delete `native/patches/`, and declare victory.
- The only actual enforcement in the repo was CI (`build-apk.yml` runs typecheck + jest on push/PR) — which catches failures *after* they're pushed, not before they're claimed as done.

Verdict: everything except CI was hope. This system replaces hope with files.

## Enforcement map

| Behavior | Enforced by | Mechanism |
|---|---|---|
| No "done" while `native/` source is changed but untested | `.claude/hooks/delivery-gate.mjs` | `Stop` hook, exit 2 blocks finishing |
| No `.claude/` change without passing evals | `.claude/hooks/delivery-gate.mjs` | same |
| What actually ran (vs. what was claimed) is on record | `.claude/hooks/evidence-logger.mjs` | `PostToolUse(Bash)` → `.claude/evidence/*.jsonl` (gitignored) |
| No force-push to master, no `rm -rf` of `.git`/root/`native/patches`, no shell edits of jest config | `.claude/hooks/risk-guard.mjs` | `PreToolUse(Bash)`, exit 2 blocks the call |
| Subagent fan-out capped (25/session) | `.claude/hooks/budget-governor.mjs` | `PreToolUse(Agent)`, exit 2 past cap |
| Context survives compaction | `.claude/hooks/pre-compact-handoff.mjs` | `PreCompact` → `.claude/memory/handoff-latest.md` |
| Sessions start from reality (branch, dirt, last incident, pending handoff) | `.claude/hooks/session-audit.mjs` | `SessionStart`, stdout → context |
| Hook wiring itself can't silently rot | `.claude/evals/010-system-integrity.eval.mjs` | eval: settings valid, scripts exist & parse |
| Agent contracts stay complete and short (≤60 lines) | `.claude/evals/020-agent-contracts.eval.mjs` | eval |
| Track-player Media3/Android Auto patch can't be silently lost | `.claude/evals/030-track-player-patch.eval.mjs` | eval |
| Code quality of the app itself | `.github/workflows/build-apk.yml` | CI: typecheck + jest (pre-existing) |

Not enforced by files (known, accepted): memory-log format and doc leanness are maintained by the **context-librarian** agent on request; the "check Expo SDK 57 docs first" rule is prompt-level only.

## The team

Nine agents in `.claude/agents/`, each a strict contract: mission, scope (allowed/forbidden), required evidence, bounded output, refusal conditions. Eval 020 rejects any contract missing those parts.

| Agent | Model | Role |
|---|---|---|
| chief-operator | opus | main-session orchestrator; decides, delegates, hands off |
| builder | sonnet | scoped implementation in `native/` |
| qa-engineer | sonnet | PASS/FAIL verification with command evidence |
| adversarial-critic | inherit (top tier) | attacks "done" claims, plans, handoffs; read-only |
| system-fixer | sonnet | repairs `.claude/` machinery; must ship an eval with each fix |
| eval-designer | sonnet | turns a twice-seen failure into a runnable eval |
| improvement-analyst | inherit (top tier) | mines ops-log + evidence for systemic patches (max 3/run) |
| context-librarian | haiku | prunes docs/memory; subtraction only |
| research-scout | haiku | bounded primary-source research (Expo v57 docs etc.) |

Launch the chief: `claude --agent chief-operator`. Model routing rationale is in root `CLAUDE.md`: top-tier models for judgment (audit/critique/architecture), opus for orchestration discipline, sonnet/haiku for bounded work.

## The loop worth protecting

Big goal → understand intent → split into microtasks → dispatch with contracts → tools early → read digests → decide → patch the system when it failed → verify (evidence, not vibes) → handoff → continue.

When something annoying happens twice: **eval-designer** encodes it, one line goes into `.claude/memory/operations-log.md` (`date | failure | root cause | patch | eval | next`), and the improvement-analyst reviews the log periodically. Skills are deliberately *not* preloaded here — the system starts with zero project skills, and ones get added only when a repeated need shows up (a skill router with nothing to route is bloat wearing a lanyard).

## Maintaining it

- `node .claude/evals/run.mjs` — run after touching anything in `.claude/` (the delivery gate makes you).
- Hook misbehaving? Dispatch **system-fixer** with the incident; it must narrow the rule and ship an eval.
- Local, uncommitted state: `.claude/evidence/` (per-session JSONL) and `.claude/memory/handoff-latest.md` are gitignored on purpose — they're session telemetry, not shared truth. The operations log **is** committed; it's the team's shared incident history.
