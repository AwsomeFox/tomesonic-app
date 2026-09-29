// Invariant: every agent has a complete, bounded contract. An agent without
// scope, evidence requirements, and output limits produces expensive fog.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'agent-contracts: frontmatter + mission/scope/output-limit/refusal in every agent'

const agentsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'agents')

const REQUIRED_FRONTMATTER = ['name:', 'description:', 'model:']
// Every contract must state its mission, its scope, a bounded output, and
// when to refuse. Checked as content, not headings, so phrasing can vary.
const REQUIRED_CONTENT = [/mission/i, /scope/i, /output contract|output \(max|max ~?\d+ lines/i, /refuse/i]
const MAX_LINES = 60 // short prompts, not museums

export async function check() {
  const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md'))
  if (files.length === 0) throw new Error('no agents defined in .claude/agents/')
  const problems = []

  for (const file of files) {
    const text = fs.readFileSync(path.join(agentsDir, file), 'utf8')
    for (const key of REQUIRED_FRONTMATTER) {
      if (!text.includes(key)) problems.push(`${file}: missing frontmatter "${key}"`)
    }
    if (file !== 'chief-operator.md') {
      for (const re of REQUIRED_CONTENT) {
        if (!re.test(text)) problems.push(`${file}: contract missing ${re}`)
      }
    }
    const lines = text.split('\n').length
    if (lines > MAX_LINES) problems.push(`${file}: ${lines} lines (max ${MAX_LINES}) — trim it`)
  }

  if (problems.length) throw new Error(problems.join('\n'))
}
