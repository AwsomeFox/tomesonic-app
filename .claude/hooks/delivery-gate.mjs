// Stop hook: no "done" without proof. If source changed, a successful test or
// typecheck run must exist in the evidence log; if the agent system itself
// changed, the evals must have been run. Exit 2 blocks the stop.
import { readHookInput, recentEvidence, git, block } from './_lib.mjs'

const input = await readHookInput()
// stop_hook_active means we already blocked once this stop — don't loop.
if (input.stop_hook_active) process.exit(0)

const changed = git('status --porcelain')
  .split('\n')
  .filter(Boolean)
  .map((l) => l.slice(3).trim())

const appCodeChanged = changed.some(
  (f) => /\.(ts|tsx|js|jsx|mjs|kt|java)$/.test(f) && f.startsWith('native/')
)
const systemChanged = changed.some((f) => f.startsWith('.claude/') && !f.startsWith('.claude/evidence'))

const evidence = recentEvidence()
const verified = (kinds) => evidence.some((e) => kinds.includes(e.kind) && e.ok)

if (appCodeChanged && !verified(['test', 'typecheck'])) {
  block(
    '[delivery-gate] Uncommitted changes under native/ but no successful test or typecheck run is recorded this session. ' +
      'Run `cd native && npm run typecheck && npm test` (or the relevant jest area) before finishing — or revert the changes if they were exploratory.'
  )
}

if (systemChanged && !verified(['evals'])) {
  block(
    '[delivery-gate] .claude/ system files changed but the system evals have not been run. ' +
      'Run `node .claude/evals/run.mjs` and fix any FAIL before finishing.'
  )
}

process.exit(0)
