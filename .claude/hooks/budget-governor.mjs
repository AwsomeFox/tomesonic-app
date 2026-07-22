// PreToolUse(Agent|Workflow) hook: hard cap on subagent spawns per session.
// Past the cap, more agents means fog, not progress — consolidate or ask.
import { readHookInput, appendEvidence, recentEvidence, block } from './_lib.mjs'

const CAP = 25

const input = await readHookInput()
const spawned = recentEvidence().filter(
  (e) => e.kind === 'agent-spawn' && e.session === input.session_id
).length

if (spawned >= CAP) {
  block(
    `[budget-governor] ${spawned} subagents already spawned this session (cap ${CAP}). ` +
      'Stop fanning out: consolidate findings, finish the work in the main session, or ask the user before continuing.'
  )
}

appendEvidence(input.session_id, {
  kind: 'agent-spawn',
  session: input.session_id,
  n: spawned + 1,
})
process.exit(0)
