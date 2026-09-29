// Shared helpers for TomeSonic Claude Code hooks. Node-only (no deps) —
// node is already a prerequisite for developing this app.
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

export const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd()
export const evidenceDir = path.join(projectDir, '.claude', 'evidence')

export async function readHookInput() {
  let data = ''
  for await (const chunk of process.stdin) data += chunk
  try {
    return JSON.parse(data)
  } catch {
    return {}
  }
}

export function appendEvidence(sessionId, entry) {
  fs.mkdirSync(evidenceDir, { recursive: true })
  const file = path.join(evidenceDir, `${sessionId || 'unknown'}.jsonl`)
  fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
}

// All evidence entries recorded recently (any session — subagents log under
// their own session ids, and their verification runs count too).
export function recentEvidence(maxAgeHours = 12) {
  if (!fs.existsSync(evidenceDir)) return []
  const cutoff = Date.now() - maxAgeHours * 3600 * 1000
  const entries = []
  for (const name of fs.readdirSync(evidenceDir)) {
    if (!name.endsWith('.jsonl')) continue
    const file = path.join(evidenceDir, name)
    if (fs.statSync(file).mtimeMs < cutoff) continue
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        entries.push(JSON.parse(line))
      } catch {
        /* skip corrupt line */
      }
    }
  }
  return entries
}

export function git(args) {
  try {
    return execSync(`git ${args}`, { cwd: projectDir, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

// Exit code 2 = hard block; stderr is fed back to Claude.
export function block(reason) {
  process.stderr.write(reason)
  process.exit(2)
}
