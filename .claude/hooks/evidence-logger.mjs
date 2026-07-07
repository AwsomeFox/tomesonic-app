// PostToolUse(Bash) hook: append what actually ran to .claude/evidence/ so the
// delivery gate can distinguish "verified" from "claimed". Never blocks.
import { readHookInput, appendEvidence } from './_lib.mjs'

const input = await readHookInput()
const cmd = input.tool_input?.command || ''
const responseText = JSON.stringify(input.tool_response ?? '')

let kind = 'cmd'
if (/\bjest\b|npm\s+(run\s+)?test\b|test:coverage/.test(cmd)) kind = 'test'
else if (/typecheck|tsc\s+--noEmit/.test(cmd)) kind = 'typecheck'
else if (/evals\/run\.mjs/.test(cmd)) kind = 'evals'
else if (/\bmaestro\s+test\b|npm\s+run\s+e2e/.test(cmd)) kind = 'e2e'

// Heuristic pass/fail detection from the tool response. Good enough for the
// gate; the QA agent still reads real output before declaring PASS.
const failed =
  /Tests:\s+\d+\s+failed|(?<!\d)FAIL\s|error TS\d|EVALS FAILED|"interrupted":\s*true|Exit code [1-9]/.test(
    responseText
  )

appendEvidence(input.session_id, {
  kind,
  ok: !failed,
  command: cmd.slice(0, 300),
})
process.exit(0)
