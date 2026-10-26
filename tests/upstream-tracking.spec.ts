import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readProvenance, writeProvenance } from '../src/provenance-store.ts'
import { githubRepository, parseUpstream, upstreamLink, type UpstreamResult, type UpstreamTracking } from '../src/upstream-types.ts'
import { inspectUpstream, UpstreamFailure } from '../src/upstream-network.ts'
import { UpstreamTracker, UPSTREAM_INTERVAL_MS, UPSTREAM_MANUAL_MS, UPSTREAM_RETRY_MS } from '../src/upstream-tracker.ts'

let root: string
const trackers: UpstreamTracker[] = []
const sha = 'a'.repeat(40), head = 'b'.repeat(40)
const npm: UpstreamTracking = { repository: 'owner/plugin', mode: 'npm', packageName: 'original-plugin', baseVersion: '5.10.0' }
const branch: UpstreamTracking = { repository: 'owner/plugin', mode: 'branch', branch: 'main', baseCommit: sha }
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-upstream-'))
  mkdirSync(join(root, 'node_modules', 'local-plugin'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'local-plugin', 'package.json'), '{"name":"local-plugin","version":"5.11.0"}')
  writeFileSync(join(root, 'package.json'), '{"dependencies":{"local-plugin":"file:./local.tgz"}}')
})
afterEach(() => { trackers.splice(0).forEach(t => t.stop()); vi.useRealTimers(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }) })
const attach = (tracking = npm) => writeProvenance(root, 'local-plugin', { category: 'modified', upstream: tracking })
const tracker = (inspect = inspectUpstream, now = Date.now) => { const value = new UpstreamTracker(root, 'web', inspect, now); trackers.push(value); return value }
const response = (data: unknown, init?: ResponseInit) => new Response(JSON.stringify(data), init)
const success = (): UpstreamResult => ({ state: 'updates', latest: '5.10.1' })

describe('explicit upstream identity', () => {
  it('normalizes GitHub identities but refuses credentials, arbitrary servers and query tricks', () => {
    expect(githubRepository('git+https://github.com/Owner/Plugin.git')).toBe('owner/plugin')
    for (const input of ['https://127.0.0.1/private', 'https://github.com.evil/owner/repo', 'https://user:pass@github.com/owner/repo', 'owner/repo?x=y', 'https://github.com/a/b/tree/main', 'a/../b', 'javascript:alert(1)']) expect(githubRepository(input)).toBeNull()
  })
  it('validates baselines without inventing or advancing them', () => {
    expect(parseUpstream({ ...npm, baseVersion: '' })).toEqual({ repository: npm.repository, mode: 'npm', packageName: npm.packageName })
    for (const value of [{ ...branch, branch: '../secret' }, { ...branch, branch: 'main?x=1' }, { ...branch, baseCommit: 'short' }, { ...npm, packageName: '../../x' }, { ...npm, baseVersion: 'latest' }]) expect(() => parseUpstream(value)).toThrow()
    expect(parseUpstream(null)).toBeUndefined()
  })
  it('round-trips tracking alongside categories and source paths; unlink does not erase them', () => {
    writeProvenance(root, 'local-plugin', { category: 'modified', sourceDirectory: 'D:/source', upstream: npm })
    expect(readProvenance(root)['local-plugin']).toEqual({ category: 'modified', sourceDirectory: 'D:/source', upstream: npm })
    const record = readProvenance(root)['local-plugin']!
    writeProvenance(root, 'local-plugin', { ...record, upstream: undefined })
    expect(readProvenance(root)['local-plugin']?.category).toBe('modified')
    expect(readProvenance(root)['local-plugin']?.upstream).toBeUndefined()
  })
  it('caps tracked associations and preserves the file on rejection', () => {
    for (let i = 0; i < 32; i++) writeProvenance(root, `plugin-${i}`, { upstream: npm })
    const file = join(root, '.dsh-market', 'plugin-provenance.json'), before = readFileSync(file)
    expect(() => writeProvenance(root, 'too-many', { upstream: npm })).toThrow('32')
    expect(readFileSync(file)).toEqual(before)
  })
})

describe('bounded public metadata inspection', () => {
  it('compares the merged baseline, never the installed 5.11.0 custom version', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ name: 'original-plugin', version: '5.10.1', repository: { url: 'git+https://github.com/owner/plugin.git' } })))
    expect(await inspectUpstream(npm, AbortSignal.timeout(1000))).toMatchObject({ state: 'updates', latest: '5.10.1' })
    expect(await inspectUpstream({ ...npm, baseVersion: undefined }, AbortSignal.timeout(1000))).toMatchObject({ state: 'baseline-needed', latest: '5.10.1' })
  })
  it.each([['5.10.0', 'current'], ['5.9.0', 'ahead']])('reports npm %s relative to the recorded baseline as %s', async (version, state) => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ name: npm.packageName, version, repository: 'https://github.com/owner/plugin' })))
    expect(await inspectUpstream(npm, AbortSignal.timeout(1000))).toMatchObject({ state })
  })
  it('refuses a same-name package from a different repository', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ name: npm.packageName, version: '9.0.0', repository: 'https://github.com/other/plugin' })))
    await expect(inspectUpstream(npm, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'repo-mismatch' })
  })
  it.each([['ahead', 3, 0, 'updates'], ['behind', 0, 2, 'ahead'], ['diverged', 2, 1, 'diverged']])('uses GitHub ancestry for %s, not a differing hash alone', async (status, ahead_by, behind_by, state) => {
    const fetch = vi.fn(async (url: string) => response(url.includes('/compare/') ? { status, ahead_by, behind_by } : { sha: head }))
    vi.stubGlobal('fetch', fetch)
    expect(await inspectUpstream(branch, AbortSignal.timeout(1000))).toMatchObject({ state, latest: head, aheadBy: ahead_by, behindBy: behind_by })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[1]![0]).toContain(`/compare/${sha}...${head}`)
    expect(upstreamLink(branch, { state: 'updates', latest: head })).toBe(`https://github.com/owner/plugin/compare/${sha}...${head}`)
  })
  it('handles identical heads, absent baselines and a branch containing slashes', async () => {
    const fetch = vi.fn(async (_url: string) => response({ sha }))
    vi.stubGlobal('fetch', fetch)
    expect(await inspectUpstream({ ...branch, branch: 'feature/tools' }, AbortSignal.timeout(1000))).toMatchObject({ state: 'current' })
    expect(fetch.mock.calls[0]![0]).toContain('feature%2Ftools')
    expect(await inspectUpstream({ ...branch, baseCommit: undefined }, AbortSignal.timeout(1000))).toMatchObject({ state: 'baseline-needed' })
  })
  it.each([404, 429, 500])('never calls HTTP %s current', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => response({}, { status })))
    await expect(inspectUpstream(npm, AbortSignal.timeout(1000))).rejects.toBeInstanceOf(UpstreamFailure)
  })
  it('rejects invalid, contradictory, oversized and redirected response contracts', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url.includes('/compare/') ? { status: 'identical', ahead_by: 4, behind_by: 0 } : { sha: head })))
    await expect(inspectUpstream(branch, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'invalid-data' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))))
    await expect(inspectUpstream(npm, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'invalid-data' })
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => { throw new Error('redirect refused') }); vi.stubGlobal('fetch', fetch)
    await expect(inspectUpstream(npm, AbortSignal.timeout(1000))).rejects.toThrow()
    expect(fetch.mock.calls[0]![1]).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) })
  })
})

describe('tracker lifecycle and persistence', () => {
  it('persists observation over restart without changing code, install metadata or baseline', async () => {
    attach(); const file = join(root, 'package.json'), baseline = readFileSync(file)
    const first = tracker(vi.fn(async () => success()))
    await first.check('local-plugin'); first.stop()
    const inspect = vi.fn(async () => success()), second = tracker(inspect)
    expect((await second.check('local-plugin')).result.state).toBe('updates')
    expect(inspect).not.toHaveBeenCalled()
    expect(readProvenance(root)['local-plugin']?.upstream?.baseVersion).toBe('5.10.0')
    expect(readFileSync(file)).toEqual(baseline)
    expect(JSON.parse(readFileSync(join(root, 'node_modules', 'local-plugin', 'package.json'), 'utf8')).version).toBe('5.11.0')
  })
  it('deduplicates simultaneous checks and enforces manual cooldown without network', async () => {
    attach(); let now = Date.now(), finish!: (r: UpstreamResult) => void
    const inspect = vi.fn(() => new Promise<UpstreamResult>(done => { finish = done })), t = tracker(inspect, () => now)
    const a = t.check('local-plugin', true), b = t.check('local-plugin', true)
    expect(inspect).toHaveBeenCalledTimes(1); finish(success()); await Promise.all([a, b])
    await t.check('local-plugin', true); expect(inspect).toHaveBeenCalledTimes(1)
    now += UPSTREAM_MANUAL_MS + 1
    const c = t.check('local-plugin', true); finish(success()); await c
    expect(inspect).toHaveBeenCalledTimes(2)
  })
  it('keeps a failed check distinct from a prior success and retains pending-update evidence', async () => {
    attach(); let now = Date.now()
    const inspect = vi.fn().mockResolvedValueOnce(success()).mockRejectedValueOnce(new Error('offline token=not logged'))
    const t = tracker(inspect, () => now)
    await t.check('local-plugin'); now += UPSTREAM_INTERVAL_MS + 1
    expect(t.views()['local-plugin']?.stale).toBe(true)
    const result = await t.check('local-plugin')
    expect(result.result).toMatchObject({ state: 'error', error: 'network' })
    expect(result.previousSuccess?.state).toBe('updates')
    expect(result.nextCheckAt).toBe(new Date(now + UPSTREAM_RETRY_MS).toISOString())
    expect(readFileSync(join(root, '.dsh-market', 'upstream-checks.json'), 'utf8')).not.toContain('token')
  })
  it('does not commit a stale response after the association or baseline changes', async () => {
    attach(); let finish!: (r: UpstreamResult) => void
    const t = tracker(() => new Promise(done => { finish = done }))
    const result = t.check('local-plugin')
    attach({ ...npm, baseVersion: '5.10.1' }); finish(success())
    await expect(result).rejects.toThrow('association changed')
    expect(t.views()['local-plugin']?.result.state).toBe('unchecked')
  })
  it('rejects unavailable installations, unlinking, corrupt observations and unknown metadata versions', async () => {
    attach(); const t = tracker(vi.fn(async () => success()))
    writeFileSync(join(root, 'package.json'), '{"dependencies":{}}')
    await expect(t.check('local-plugin')).rejects.toThrow('installed plugin')
    writeFileSync(join(root, 'package.json'), '{"dependencies":{"local-plugin":"file:./local.tgz"}}')
    writeFileSync(join(root, '.dsh-market', 'upstream-checks.json'), '{"version":2,"plugins":{}}')
    expect(t.views()['local-plugin']?.result).toMatchObject({ state: 'error', error: 'storage' })
    await expect(t.check('local-plugin')).rejects.toThrow()
  })
  it('aborts in-flight work and cannot persist after teardown', async () => {
    attach(); let signal!: AbortSignal
    const t = tracker((_config, s) => { signal = s; return new Promise((_done, reject) => s.addEventListener('abort', () => reject(new Error('aborted')))) })
    const check = t.check('local-plugin'); t.stop()
    expect(signal.aborted).toBe(true)
    await expect(check).rejects.toThrow('stopped')
    await expect(t.check('local-plugin')).rejects.toThrow('stopped')
    expect(readProvenance(root)['local-plugin']?.upstream).toEqual(npm)
  })
  it('limits simultaneous requests to two and pauses a rate-limited provider', async () => {
    const installed: Record<string, string> = {}
    for (const name of ['one', 'two', 'three']) { installed[name] = 'file:local.tgz'; writeProvenance(root, name, { upstream: npm }) }
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: installed }))
    const completions: Array<() => void> = []
    const t = tracker(() => new Promise<UpstreamResult>((_done, reject) => { completions.push(() => reject(new UpstreamFailure('rate-limit', 3600_000))) }))
    const first = t.check('one'), second = t.check('two')
    await expect(t.check('three')).rejects.toThrow('Other upstreams')
    const inspect = vi.fn().mockRejectedValue(new UpstreamFailure('rate-limit', 3600_000)), limited = tracker(inspect)
    await limited.check('three')
    await expect(limited.check('one')).rejects.toThrow('limited')
    completions.forEach(complete => complete()); await Promise.all([first, second])
  })
  it('automatically checks on startup and later sweeps, but not when unlinked or stopped', async () => {
    vi.useFakeTimers(); attach()
    const inspect = vi.fn(async () => success()), t = tracker(inspect)
    t.start(); t.start()
    await vi.advanceTimersByTimeAsync(15_001)
    expect(inspect).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(UPSTREAM_INTERVAL_MS + UPSTREAM_RETRY_MS)
    expect(inspect).toHaveBeenCalledTimes(2)
    t.stop(); await vi.advanceTimersByTimeAsync(UPSTREAM_INTERVAL_MS)
    expect(inspect).toHaveBeenCalledTimes(2)
  })
  it('carries rate-limit backoff over a restart, including explicit checks', async () => {
    attach(); let now = Date.now()
    const inspect = vi.fn().mockRejectedValue(new UpstreamFailure('rate-limit', 3600_000)), first = tracker(inspect, () => now)
    await first.check('local-plugin'); first.stop(); now += 120_000
    const next = vi.fn(async () => success()), second = tracker(next, () => now)
    expect((await second.check('local-plugin', true)).result.error).toBe('rate-limit')
    expect(next).not.toHaveBeenCalled()
  })
  it('a failed cache write is visible even when a previous current result is still fresh', async () => {
    attach(); let now = Date.now()
    const t = tracker(vi.fn(async () => ({ state: 'current', latest: '5.10.0' } as UpstreamResult)), () => now)
    await t.check('local-plugin'); now += UPSTREAM_MANUAL_MS + 1
    const store = await import('../src/provenance-store.ts')
    const write = vi.spyOn(store, 'writeLocalJson').mockImplementationOnce(() => { throw new Error('disk full') })
    try {
      expect((await t.check('local-plugin', true)).result).toMatchObject({ state: 'error', error: 'storage' })
      expect(t.views()['local-plugin']?.result).toMatchObject({ state: 'error', error: 'storage' })
      expect(readProvenance(root)['local-plugin']?.upstream?.baseVersion).toBe('5.10.0')
    } finally { write.mockRestore() }
  })
})
