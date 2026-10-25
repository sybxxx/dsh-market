import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cwd = fileURLToPath(new URL('..', import.meta.url))
const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 60_000 }).trim()
try {
  // Updates tracking refs only. Never merges, pushes, installs or restarts DSH.
  git('fetch', 'upstream', 'main', '--tags')
  const base = git('merge-base', 'HEAD', 'upstream/main')
  const count = git('rev-list', '--count', `${base}..upstream/main`)
  process.stdout.write(`Upstream commits not yet merged: ${count}\n`)
  if (count !== '0') process.stdout.write(git('log', '--oneline', '-15', `${base}..upstream/main`) + '\n')
  process.stdout.write(`Upstream: ${git('rev-parse', '--short', 'upstream/main')}\nLocal: ${git('rev-parse', '--short', 'HEAD')}\n`)
} catch (error) {
  process.stderr.write('Could not check upstream. Local code and the installed DSH were not changed.\n')
  process.stderr.write(String(error.message) + '\n')
  process.exitCode = 1
}
