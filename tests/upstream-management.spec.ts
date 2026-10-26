import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { mountInstalledManagement, readProvenance } from '../src/installed-management.ts'
import { UpstreamTracker } from '../src/upstream-tracker.ts'
import { inspectUpstream } from '../src/upstream-network.ts'

let root: string
let call: (path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; result: any }>
let dispose: Array<() => void>
const tracking = { repository: 'owner/original', mode: 'npm', packageName: 'original-package', baseVersion: '5.10.0' }
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-upstream-route-'))
  mkdirSync(join(root, 'node_modules', 'plugin'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"dependencies":{"plugin":"file:plugin.tgz"}}')
  writeFileSync(join(root, 'node_modules', 'plugin', 'package.json'), '{"name":"plugin","version":"5.11.0"}')
  const handlers = new Map<string, (request: IncomingMessage, response: ServerResponse) => void | Promise<void>>()
  const tracker = new UpstreamTracker(root, 'web', inspectUpstream)
  dispose = mountInstalledManagement(route => { handlers.set(route.path, route.handler); return () => handlers.delete(route.path) }, root, 'web', async () => {}, tracker)
  call = async (path, body, headers = {}) => {
    const req = Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), {
      method: body === undefined ? 'GET' : 'POST', headers: { host: 'localhost:3080', origin: 'http://localhost:3080', ...headers }, socket: { remoteAddress: '127.0.0.1' },
    }) as IncomingMessage
    let status = 0, result: any
    await handlers.get(path)!(req, { writeHead: (code: number) => { status = code }, end: (text: string) => { result = JSON.parse(text) } } as unknown as ServerResponse)
    return { status, result }
  }
})
afterEach(() => { dispose.forEach(fn => fn()); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }) })
const save = (extra: object = {}) => call('/dsh-market/plugin-provenance', { name: 'plugin', category: 'modified', sourceDirectory: '', upstream: tracking, ...extra })

describe('upstream HTTP routes', () => {
  it('links, checks, reloads and unlinks without changing package/version metadata', async () => {
    const before = readFileSync(join(root, 'package.json'))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ name: 'original-package', version: '5.10.1', repository: 'https://github.com/owner/original' }))))
    expect((await save()).status).toBe(200)
    expect((await call('/dsh-market/installed-tools')).result.plugins.plugin.upstreamStatus.result.state).toBe('unchecked')
    const checked = await call('/dsh-market/check-upstream', { name: 'plugin' })
    expect(checked.result.status.result.state).toBe('updates')
    const read = await call('/dsh-market/installed-tools')
    expect(read.result.plugins.plugin.upstream.baseVersion).toBe('5.10.0')
    expect(read.result.plugins.plugin.upstreamStatus.result.latest).toBe('5.10.1')
    await save({ upstream: null })
    expect(readProvenance(root).plugin?.upstream).toBeUndefined()
    expect((await call('/dsh-market/check-upstream', { name: 'plugin' })).status).toBe(400)
    expect(readFileSync(join(root, 'package.json'))).toEqual(before)
  })
  it('older clients changing a category preserve explicit upstream records', async () => {
    await save()
    const r = await call('/dsh-market/plugin-provenance', { name: 'plugin', category: 'original', sourceDirectory: '' })
    expect(r.status).toBe(200)
    expect(readProvenance(root).plugin?.upstream).toEqual(tracking)
  })
  it('a stale editor cannot silently overwrite a baseline advanced in another window', async () => {
    await save()
    const advanced = { ...tracking, baseVersion: '5.10.1' }
    expect((await save({ upstream: advanced, expectedUpstream: tracking })).status).toBe(200)
    const stale = await save({ upstream: tracking, expectedUpstream: tracking })
    expect(stale.status).toBe(400)
    expect(stale.result.error).toContain('changed elsewhere')
    expect(readProvenance(root).plugin?.upstream?.baseVersion).toBe('5.10.1')
  })
  it('refuses unsafe inputs and cross-origin checks before external reads or writes', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    for (const upstream of [{ ...tracking, repository: 'https://localhost/secret' }, { ...tracking, baseVersion: 'latest' }, { mode: 'branch', repository: 'owner/original', branch: 'main', baseCommit: 'abc' }]) {
      expect((await save({ upstream })).status).toBe(400)
    }
    await save()
    expect((await call('/dsh-market/check-upstream', { name: 'plugin' }, { origin: 'https://evil.example' })).status).toBe(403)
    expect((await call('/dsh-market/check-upstream', { name: '../secret' })).status).toBe(400)
    expect((await call('/dsh-market/check-upstream', { name: 'plugin-not-installed' })).status).toBe(400)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('real streamed metadata through a loopback transport reaches the same inspector and persists a result', async () => {
    const nativeFetch = globalThis.fetch
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.write('{"name":"original-package","version":"5.10.1",')
      res.end('"repository":{"url":"git+https://github.com/owner/original.git"}}')
    })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const port = (server.address() as { port: number }).port
    const outbound: string[] = []
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      outbound.push(url)
      return nativeFetch(`http://127.0.0.1:${port}/metadata`, init)
    })
    try {
      await save()
      expect((await call('/dsh-market/check-upstream', { name: 'plugin' })).result.status.result).toMatchObject({ state: 'updates', latest: '5.10.1' })
      expect(outbound).toEqual(['https://registry.npmjs.org/original-package/latest'])
      expect((await call('/dsh-market/installed-tools')).result.plugins.plugin.upstreamStatus.result.state).toBe('updates')
    } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) }
  })
  it('an unfinished metadata body is aborted by its request deadline rather than read forever', async () => {
    const nativeFetch = globalThis.fetch
    const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"unfinished":') })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const port = (server.address() as { port: number }).port
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => nativeFetch(`http://127.0.0.1:${port}/metadata`, init))
    try {
      const started = Date.now()
      await expect(inspectUpstream({ repository: 'owner/original', mode: 'npm', packageName: 'original-package' }, AbortSignal.timeout(150))).rejects.toThrow()
      expect(Date.now() - started).toBeLessThan(3000)
    } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) }
  })
})
