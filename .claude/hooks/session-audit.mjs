// SessionStart hook: surface operational state so every session starts from
// reality, not assumptions. stdout is injected into Claude's context.
import fs from 'node:fs'
import path from 'node:path'
import { projectDir, git } from './_lib.mjs'

const lines = []
const branch = git('branch --show-current') || '(detached)'
const dirty = git('status --porcelain')
const dirtyCount = dirty ? dirty.split('\n').length : 0
lines.push(`[session-audit] branch: ${branch}; uncommitted files: ${dirtyCount}`)

const opsLog = path.join(projectDir, '.claude', 'memory', 'operations-log.md')
if (fs.existsSync(opsLog)) {
  const lastEntry = fs
    .readFileSync(opsLog, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('| 2'))
    .pop()
  if (lastEntry) lines.push(`[session-audit] last operations-log entry: ${lastEntry}`)
}

const handoff = path.join(projectDir, '.claude', 'memory', 'handoff-latest.md')
if (fs.existsSync(handoff)) {
  const ageMin = Math.round((Date.now() - fs.statSync(handoff).mtimeMs) / 60000)
  lines.push(
    `[session-audit] handoff from a previous session exists (${ageMin} min old): read .claude/memory/handoff-latest.md before starting work.`
  )
}

lines.push(
  '[session-audit] system checks: `node .claude/evals/run.mjs` | delegation + model routing: CLAUDE.md | agent contracts: .claude/agents/'
)
process.stdout.write(lines.join('\n') + '\n')
