import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { installedSources, mountInstalledManagement, readProvenance, writeProvenance } from '../src/installed-management.ts'
import { folderCommand, installedLocation, localFilePath, localFolderRequest, validateSourceDirectory } from '../src/installed-locations.ts'
import { sourceCategory } from '../src/plugin-provenance.ts'
import { cleanHotDir, readMarketState, writeMarketState } from '../src/hot.ts'

let root: string
let source: string
const metadataPath = () => join(root, '.dsh-market', 'plugin-provenance.json')
const request = (headers: Record<string, string> = {}, remoteAddress = '127.0.0.1') => ({ headers, socket: { remoteAddress } }) as IncomingMessage
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dshm-sources-'))
  source = join(root, 'source with spaces & symbols')
  mkdirSync(source)
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'local-plugin', version: '1.0.0' }))
  mkdirSync(join(root, 'node_modules', 'local-plugin'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'local-plugin', 'package.json'), JSON.stringify({ name: 'local-plugin', version: '1.0.0' }))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'local-plugin': 'file:package.tgz', 'online-plugin': '1.0.0' } }))
  writeFileSync(join(root, 'package.tgz'), 'inert test archive')
})
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks() })

describe('source classification and durable metadata', () => {
  it('does not guess the authorship of local directories or archives', () => {
    expect(sourceCategory('file:package.tgz')).toBe('unclassified')
    expect(sourceCategory('link:../project')).toBe('unclassified')
    expect(sourceCategory('1.2.3')).toBe('online')
    expect(sourceCategory('github:owner/plugin')).toBe('online')
    expect(sourceCategory('link:../.generations/live/pkg/node_modules/pkg')).toBe('online')
    expect(sourceCategory('file:package.tgz', { category: 'modified' })).toBe('modified')
  })
  it('preserves other records, market state and restarts, with an automatic reset', () => {
    writeMarketState(root, { disabled: new Set(['online-plugin']), groups: { tools: ['local-plugin'] }, groupOrder: ['tools'], notes: { 'local-plugin': 'keep' } })
    writeProvenance(root, 'local-plugin', { category: 'modified', sourceDirectory: source })
    writeProvenance(root, 'online-plugin', { category: 'original' })
    cleanHotDir(root)
    expect(readProvenance(root)['local-plugin']).toEqual({ category: 'modified', sourceDirectory: source })
    writeMarketState(root, { ...readMarketState(root), disabled: new Set() })
    expect(readProvenance(root)['online-plugin']?.category).toBe('original')
    expect(readMarketState(root).notes).toEqual({ 'local-plugin': 'keep' })
    writeProvenance(root, 'local-plugin', {})
    expect(readProvenance(root)['local-plugin']).toBeUndefined()
    expect(readProvenance(root)['online-plugin']?.category).toBe('original')
  })
  it('refuses to overwrite corrupt or unknown metadata', () => {
    mkdirSync(join(root, '.dsh-market'))
    for (const text of ['{broken', '{"version":2,"plugins":{}}', '{"version":1,"plugins":[]}']) {
      writeFileSync(metadataPath(), text)
      expect(() => writeProvenance(root, 'local-plugin', { category: 'modified' })).toThrow('not overwritten')
      expect(readFileSync(metadataPath(), 'utf8')).toBe(text)
    }
  })
})

describe('installed, source and archive locations', () => {
  it('keeps runtime, source and archives distinct and resolves profile-relative paths', () => {
    const entry = installedLocation(root, 'local-plugin', 'file:package.tgz', { sourceDirectory: source, category: 'modified' })
    expect(entry.installedDirectory).toBe(join(root, 'node_modules', 'local-plugin'))
    expect(entry.sourceDirectory).toBe(source)
    expect(entry.archive).toBe(join(root, 'package.tgz'))
    expect(installedLocation(root, 'local-plugin', `file:${source}`).sourceDirectory).toBe(source)
    expect(localFilePath(root, 'file:source%20with%20spaces')).toBe(join(root, 'source with spaces'))
    expect(localFilePath(root, 'file:%2f%2fserver/share')).toBeUndefined()
    expect(localFilePath(root, 'file:\\\\server\\share')).toBeUndefined()
    expect(localFilePath(root, 'file:%ZZ')).toBeUndefined()
  })
  it('revalidates stale and mismatched source folders before opening', () => {
    expect(() => validateSourceDirectory(source, 'other-plugin')).toThrow('does not match')
    expect(() => validateSourceDirectory('relative', 'local-plugin')).toThrow()
    writeFileSync(join(source, 'package.json'), '{"name":"other-plugin"}')
    const entry = installedLocation(root, 'local-plugin', 'file:package.tgz', { sourceDirectory: source })
    expect(entry.sourceMissing).toBe(true)
    expect(entry.sourceDirectory).toBeUndefined()
    expect(() => installedLocation(root, '../outside', '1.0.0')).toThrow()
  })
  it('builds argument arrays, not shell commands, on each platform', () => {
    const path = 'C:\\a b & stuff\\plugin'
    expect(folderCommand(path, 'win32')).toEqual({ file: join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe'), args: [path] })
    expect(folderCommand(path, 'darwin')).toEqual({ file: '/usr/bin/open', args: [path] })
    expect(folderCommand(path, 'linux')).toEqual({ file: 'xdg-open', args: [path] })
  })
  it('allows local Desktop but refuses remote, forwarded, rebinding and cross-site requests', () => {
    expect(localFolderRequest(request())).toBe(true)
    expect(localFolderRequest(request({ host: 'localhost:3080', origin: 'http://localhost:3080' }))).toBe(true)
    for (const headers of [
      { host: 'evil.example', origin: 'https://evil.example' },
      { host: 'localhost:3080', origin: 'https://evil.example' },
      { 'x-forwarded-for': '127.0.0.1' }, { forwarded: 'for=127.0.0.1' },
      { 'sec-fetch-site': 'cross-site' }, { origin: 'null' },
    ]) expect(localFolderRequest(request(headers))).toBe(false)
    expect(localFolderRequest(request({}, '192.168.1.2'))).toBe(false)
    expect(installedSources(root, 'web', request({}, '192.168.1.2')).canOpen).toBe(false)
  })
})

describe('real handlers against disposable profiles', () => {
  async function bed() {
    const handlers = new Map<string, (request: IncomingMessage, response: ServerResponse) => void | Promise<void>>()
    const open = vi.fn(async () => {})
    const dispose = mountInstalledManagement(route => { handlers.set(route.path, route.handler); return () => handlers.delete(route.path) }, root, 'web', open)
    const call = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const req = Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), request(headers), { method: body === undefined ? 'GET' : 'POST' }) as IncomingMessage
      let status = 0
      let result: any
      await handlers.get(path)!(req, { writeHead: (value: number) => { status = value }, end: (text: string) => { result = JSON.parse(text) } } as unknown as ServerResponse)
      return { status, result }
    }
    return { call, handlers, open, dispose }
  }
  it('saves, reloads and opens by package identity without changing the install', async () => {
    const before = readFileSync(join(root, 'package.json'), 'utf8')
    const { call, open, dispose, handlers } = await bed()
    expect((await call('/dsh-market/plugin-provenance', { name: 'local-plugin', category: 'modified', sourceDirectory: source })).status).toBe(200)
    expect((await call('/dsh-market/installed-tools')).result.plugins['local-plugin'].category).toBe('modified')
    await call('/dsh-market/open-plugin-folder', { name: 'local-plugin', target: 'source', path: 'ignored malicious path' })
    expect(open).toHaveBeenLastCalledWith(source)
    await call('/dsh-market/open-plugin-folder', { name: 'local-plugin', target: 'installed' })
    expect(open).toHaveBeenLastCalledWith(join(root, 'node_modules', 'local-plugin'))
    await call('/dsh-market/open-plugin-folder', { name: 'local-plugin', target: 'archive' })
    expect(open).toHaveBeenLastCalledWith(root)
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(before)
    dispose.forEach(fn => fn()); expect(handlers.size).toBe(0)
  })
  it('rejects missing plugins, unsupported targets, bad folders and cross-site writes', async () => {
    const { call, open } = await bed()
    expect((await call('/dsh-market/plugin-provenance', { name: 'missing', category: 'original', sourceDirectory: '' })).status).toBe(400)
    expect((await call('/dsh-market/plugin-provenance', { name: '../outside', category: 'original', sourceDirectory: '' })).status).toBe(400)
    expect((await call('/dsh-market/plugin-provenance', { name: 'local-plugin', category: 'wrong', sourceDirectory: '' })).status).toBe(400)
    expect((await call('/dsh-market/plugin-provenance', { name: 'local-plugin', category: 'modified', sourceDirectory: root })).status).toBe(400)
    expect((await call('/dsh-market/plugin-provenance', { name: 'local-plugin', category: 'original', sourceDirectory: '' }, { host: 'localhost', origin: 'https://evil.example' })).status).toBe(403)
    expect((await call('/dsh-market/open-plugin-folder', { name: 'local-plugin', target: 'file://evil' })).status).toBe(400)
    expect((await call('/dsh-market/open-plugin-folder', { name: 'local-plugin', target: 'source' })).status).toBe(400)
    expect((await call('/dsh-market/open-plugin-folder', { name: 'local-plugin', target: 'installed' }, { forwarded: 'for=1.2.3.4' })).status).toBe(403)
    expect(open).not.toHaveBeenCalled()
  })
  it('serves a real HTTP round trip without touching the production profile', async () => {
    const { handlers, open } = await bed()
    const server = createServer((req, res) => { void handlers.get(req.url!)!(req, res) })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const port = (server.address() as { port: number }).port
    try {
      const response = await fetch(`http://127.0.0.1:${port}/dsh-market/plugin-provenance`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'local-plugin', category: 'original', sourceDirectory: '' }) })
      expect(response.status).toBe(200)
      expect((await response.json() as any).plugin.category).toBe('original')
      expect(open).not.toHaveBeenCalled()
    } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) }
  })
  it('reports file-manager failures without changing metadata or installation', async () => {
    const { call, open } = await bed()
    open.mockRejectedValueOnce(new Error('spawn ENOENT'))
    const result = await call('/dsh-market/open-plugin-folder', { name: 'local-plugin', target: 'installed' })
    expect(result.status).toBe(400)
    expect(result.result.error).toContain('file manager could not start')
    expect(readProvenance(root)).toEqual({})
  })
})
