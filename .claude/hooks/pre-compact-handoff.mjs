// PreCompact hook: snapshot mechanical state before context is compacted, so
// the next context window (or session) can re-orient from facts, not vibes.
import fs from 'node:fs'
import path from 'node:path'
import { readHookInput, recentEvidence, git, projectDir } from './_lib.mjs'

const input = await readHookInput()
const memoryDir = path.join(projectDir, '.claude', 'memory')
fs.mkdirSync(memoryDir, { recursive: true })

const evidence = recentEvidence()
  .filter((e) => e.kind !== 'cmd')
  .slice(-10)
  .map((e) => `- ${e.ts} ${e.kind} ${e.ok ? 'OK' : 'FAILED'}: ${e.command || ''}`)

const body = `# Handoff (auto-written before compaction)

- written: ${new Date().toISOString()} (trigger: ${input.trigger || 'unknown'})
- branch: ${git('branch --show-current')}
- last commit: ${git('log -1 --oneline')}

## Uncommitted changes
\`\`\`
${git('status --porcelain') || '(clean)'}
\`\`\`

## Recent verification evidence
${evidence.join('\n') || '- none recorded'}

> Continue from here: check the operations log (.claude/memory/operations-log.md)
> and the task the user last asked for. Do not re-derive settled decisions.
`
fs.writeFileSync(path.join(memoryDir, 'handoff-latest.md'), body)
process.exit(0)
