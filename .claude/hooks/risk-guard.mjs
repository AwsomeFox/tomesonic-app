// PreToolUse(Bash) hook: block a short list of genuinely destructive commands.
// Deliberately small — an over-eager guard trains everyone to ignore it.
import { readHookInput, block } from './_lib.mjs'

const input = await readHookInput()
const cmd = input.tool_input?.command || ''

const RULES = [
  {
    // Force-pushing master/main rewrites shared history.
    re: /git\s+push\b(?=[^\n]*(?:--force\b|--force-with-lease\b|\s-f\b))(?=[^\n]*\b(?:master|main)\b)/,
    why: 'Force-pushing to master/main is blocked. Push to a feature branch instead.',
  },
  {
    // Deleting .git, the repo root, or the patches dir (patch-package patches
    // are load-bearing: react-native-track-player Media3/Android Auto).
    re: /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)[a-zA-Z]*\s+(?:--\s+)?(?:\/(?:\s|$)|~\/?(?:\s|$)|\.(?:\s|$)|\.git\b|(?:\.\/)?native\/patches\b)/,
    why: 'rm -rf on the repo root, .git, or native/patches is blocked. native/patches holds the load-bearing track-player patch.',
  },
  {
    // TESTING.md non-negotiable: never edit jest setup/config via shell tricks.
    re: /(?:>|>>|\bsed\s+-i|\btee\b)[^\n]*(?:jest\.setup\.ts|jest\.config\.js)/,
    why: 'Editing jest.setup.ts / jest.config.js is forbidden by native/TESTING.md. Use per-test mocks instead.',
  },
]

for (const rule of RULES) {
  if (rule.re.test(cmd)) block(`[risk-guard] ${rule.why}`)
}
process.exit(0)
