#!/usr/bin/env node
// Runs every *.eval.mjs in this directory. Each eval exports `name` and an
// async `check()` that throws on failure. Exit 0 = all pass.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.eval.mjs'))
  .sort()

let failed = 0
for (const file of files) {
  const mod = await import(pathToFileURL(path.join(dir, file)).href)
  const label = mod.name || file
  try {
    await mod.check()
    console.log(`PASS  ${label}`)
  } catch (err) {
    failed++
    console.log(`FAIL  ${label}`)
    console.log(`      ${String(err.message || err).split('\n').join('\n      ')}`)
  }
}

console.log(`\n${files.length - failed}/${files.length} evals passed`)
if (failed > 0) {
  console.error('EVALS FAILED')
  process.exit(1)
}
