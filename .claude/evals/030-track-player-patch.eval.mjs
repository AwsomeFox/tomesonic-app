// Invariant: react-native-track-player carries a load-bearing patch-package
// patch (Media3 / Android Auto). If the dependency exists, its patch must
// exist too — losing it breaks Android Auto silently until runtime.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'track-player-patch: patch-package patch present for react-native-track-player'

const native = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'native')

export async function check() {
  const pkg = JSON.parse(fs.readFileSync(path.join(native, 'package.json'), 'utf8'))
  const hasDep = Boolean(pkg.dependencies?.['react-native-track-player'])
  if (!hasDep) return // dependency dropped entirely — nothing to patch

  const patchesDir = path.join(native, 'patches')
  const patches = fs.existsSync(patchesDir) ? fs.readdirSync(patchesDir) : []
  const found = patches.some((f) => f.startsWith('react-native-track-player') && f.endsWith('.patch'))
  if (!found) {
    throw new Error(
      'react-native-track-player is a dependency but native/patches/ has no react-native-track-player*.patch. ' +
        'Regenerate: npx patch-package react-native-track-player --exclude "android/build"'
    )
  }
}
