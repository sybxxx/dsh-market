/** Public metadata only, with fixed origins, bounded bodies and a single deadline. */
import { marketFetch } from './net.ts'
import { compareVersions } from './updates.ts'
import { githubRepository, type UpstreamResult, type UpstreamTracking } from './upstream-types.ts'

export class UpstreamFailure extends Error {
  constructor(readonly code: NonNullable<UpstreamResult['error']>, readonly waitMs = 0) { super(code) }
}
const SHA = /^[0-9a-f]{40}$/
const MAX_BODY = 2 * 1024 * 1024

async function json(url: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const response = await marketFetch(url, { signal, redirect: 'error', headers: { accept: 'application/json', 'user-agent': 'dsh-market-upstream-tracker' } })
  if (!response.ok) {
    await response.body?.cancel()
    if (response.status === 403 || response.status === 429) {
      const seconds = Number(response.headers.get('retry-after'))
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000 - Date.now()
      throw new UpstreamFailure('rate-limit', Math.min(24 * 60 * 60_000, Math.max(30 * 60_000, seconds > 0 ? seconds * 1000 : 0, reset > 0 ? reset : 0)))
    }
    throw new UpstreamFailure(response.status === 404 ? 'not-found' : 'network')
  }
  if (Number(response.headers.get('content-length')) > MAX_BODY || response.body === null) {
    await response.body?.cancel(); throw new UpstreamFailure('invalid-data')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > MAX_BODY) { await reader.cancel(); throw new UpstreamFailure('invalid-data') }
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new UpstreamFailure('invalid-data') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UpstreamFailure('invalid-data')
  return value as Record<string, unknown>
}

export async function inspectUpstream(tracking: UpstreamTracking, signal: AbortSignal): Promise<UpstreamResult> {
  const checkedAt = new Date().toISOString()
  if (tracking.mode === 'npm') {
    const data = await json(`https://registry.npmjs.org/${encodeURIComponent(tracking.packageName!)}/latest`, signal)
    const repository = typeof data.repository === 'string' ? data.repository : (data.repository as { url?: unknown } | undefined)?.url
    if (data.name !== tracking.packageName || githubRepository(repository) !== tracking.repository) throw new UpstreamFailure('repo-mismatch')
    if (typeof data.version !== 'string' || data.version.length > 256 || compareVersions(data.version, data.version) === null) throw new UpstreamFailure('invalid-data')
    const latest = data.version
    if (!tracking.baseVersion) return { state: 'baseline-needed', latest, checkedAt }
    const compare = compareVersions(latest, tracking.baseVersion)
    if (compare === null) throw new UpstreamFailure('invalid-data')
    return { state: compare > 0 ? 'updates' : compare < 0 ? 'ahead' : 'current', latest, checkedAt }
  }
  const api = `https://api.github.com/repos/${tracking.repository}`
  const head = await json(`${api}/commits/${encodeURIComponent(tracking.branch!)}`, signal)
  if (typeof head.sha !== 'string' || !SHA.test(head.sha)) throw new UpstreamFailure('invalid-data')
  const latest = head.sha
  if (!tracking.baseCommit) return { state: 'baseline-needed', latest, checkedAt }
  if (latest === tracking.baseCommit) return { state: 'current', latest, aheadBy: 0, behindBy: 0, checkedAt }
  const compared = await json(`${api}/compare/${tracking.baseCommit}...${latest}?per_page=1`, signal)
  const ahead = compared.ahead_by, behind = compared.behind_by
  if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind) || (ahead as number) < 0 || (behind as number) < 0
    || !['ahead', 'behind', 'identical', 'diverged'].includes(String(compared.status))) throw new UpstreamFailure('invalid-data')
  const state = compared.status === 'ahead' ? 'updates' : compared.status === 'behind' ? 'ahead' : compared.status === 'identical' ? 'current' : 'diverged'
  // A malformed response cannot turn an unknown relationship into "synchronized".
  if ((state === 'current' && (ahead !== 0 || behind !== 0)) || (state === 'updates' && (!(ahead as number) || behind !== 0))
    || (state === 'ahead' && (ahead !== 0 || !(behind as number))) || (state === 'diverged' && (!(ahead as number) || !(behind as number)))) throw new UpstreamFailure('invalid-data')
  return { state, latest, aheadBy: ahead as number, behindBy: behind as number, checkedAt }
}
