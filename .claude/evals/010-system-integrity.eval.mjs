// Invariant: the hook wiring in settings.json is valid and every referenced
// hook script exists and parses. A broken hook fails silently otherwise.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

export const name = 'system-integrity: settings.json valid, all hook scripts exist and parse'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export async function check() {
  const settingsPath = path.join(root, '.claude', 'settings.json')
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) // throws if invalid

  const commands = Object.values(settings.hooks || {})
    .flat()
    .flatMap((m) => m.hooks || [])
    .map((h) => h.command || '')

  if (commands.length === 0) throw new Error('settings.json defines no hooks')

  for (const cmd of commands) {
    const match = cmd.match(/\.claude\/hooks\/[\w-]+\.mjs/)
    if (!match) throw new Error(`hook command has no .claude/hooks script: ${cmd}`)
    const script = path.join(root, match[0])
    if (!fs.existsSync(script)) throw new Error(`hook script missing: ${match[0]}`)
    // --check parses without executing.
    execFileSync(process.execPath, ['--check', script])
  }
}
