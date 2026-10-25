/** Local display metadata has its own file, so ordinary market writes cannot erase it. */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readJsonBody, sameOrigin, sendJson } from './http.ts'
import { readInstalled, readInstalledManifest } from './profile.ts'
import { installedLocation, localFolderRequest, locationTarget, openInstalledFolder, PACKAGE_NAME, validateSourceDirectory } from './installed-locations.ts'
import { isSourceChoice, type InstalledSources, type PluginProvenance } from './plugin-provenance.ts'
import type { WebServerService } from './routes.ts'

const FILE = 'plugin-provenance.json'
const MAX_BYTES = 1024 * 1024
const MAX_PLUGINS = 2000

export function readProvenance(root: string): Record<string, PluginProvenance> {
  const path = join(root, '.dsh-market', FILE)
  try {
    if (statSync(path).size > MAX_BYTES) throw new Error('metadata too large')
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (value === null || typeof value !== 'object' || (value as { version?: unknown }).version !== 1) throw new Error('unknown metadata version')
    const plugins = (value as { plugins?: unknown }).plugins
    if (plugins === null || typeof plugins !== 'object' || Array.isArray(plugins) || Object.keys(plugins).length > MAX_PLUGINS) throw new Error('invalid metadata')
    const result: Record<string, PluginProvenance> = Object.create(null)
    for (const [name, record] of Object.entries(plugins)) {
      if (!PACKAGE_NAME.test(name) || name === '__proto__' || record === null || typeof record !== 'object') throw new Error('invalid plugin metadata')
      const { category, sourceDirectory } = record as { category?: unknown; sourceDirectory?: unknown }
      if (category !== undefined && (!isSourceChoice(category) || category === 'auto')) throw new Error('invalid category')
      if (sourceDirectory !== undefined && (typeof sourceDirectory !== 'string' || sourceDirectory.length > 2048)) throw new Error('invalid source directory')
      result[name] = { category: category as PluginProvenance['category'], sourceDirectory: sourceDirectory as string | undefined }
    }
    return result
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.create(null)
    throw new Error('来源记录无法读取，未覆盖原文件。请检查 plugin-provenance.json 后重试。 / Source records could not be read and were not overwritten. Check plugin-provenance.json and retry.')
  }
}

export function writeProvenance(root: string, name: string, record: PluginProvenance): void {
  const plugins = readProvenance(root)
  if (record.category === undefined && record.sourceDirectory === undefined) delete plugins[name]
  else plugins[name] = record
  if (Object.keys(plugins).length > MAX_PLUGINS) throw new Error('too many source records')
  const text = JSON.stringify({ version: 1, plugins }, null, 2) + '\n'
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('source records too large')
  const dir = join(root, '.dsh-market')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const temporary = join(dir, `${FILE}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, join(dir, FILE))
  } finally { rmSync(temporary, { force: true }) }
}

export function installedSources(root: string, profile: string, request: IncomingMessage): InstalledSources {
  const records = readProvenance(root)
  const plugins = Object.fromEntries(Object.entries(readInstalled(profile, root))
    .map(([name, spec]) => [name, installedLocation(root, name, spec, records[name])]))
  return { plugins, canOpen: localFolderRequest(request) }
}

export function mountInstalledManagement(
  register: WebServerService['register'], root: string, profile: string,
  openFolder = openInstalledFolder,
): Array<() => void> {
  const route = (path: string, method: string, handle: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void) => register({
    kind: 'exact', path,
    handler: async (request, response) => {
      if (request.method !== method) {
        response.writeHead(405, { allow: method }); response.end(); return
      }
      if (method === 'POST' && !sameOrigin(request)) return sendJson(response, 403, { error: 'untrusted origin' })
      try { await handle(request, response) } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
  const installedSpec = (name: unknown): { name: string; spec: string } => {
    if (typeof name !== 'string' || !PACKAGE_NAME.test(name) || name === '__proto__') throw new Error('invalid package name')
    const installed = readInstalled(profile, root)
    if (!Object.hasOwn(installed, name)) throw new Error('插件已不在安装列表中，请刷新。 / Plugin is no longer installed. Refresh the list.')
    return { name, spec: installed[name]! }
  }
  return [
    route('/dsh-market/installed-tools', 'GET', (request, response) => {
      sendJson(response, 200, installedSources(root, profile, request))
    }),
    route('/dsh-market/plugin-provenance', 'POST', async (request, response) => {
      const body = await readJsonBody(request) as Record<string, unknown>
      const { name, spec } = installedSpec(body?.name)
      if (!isSourceChoice(body.category)) throw new Error('invalid category')
      if (typeof body.sourceDirectory !== 'string' || body.sourceDirectory.length > 2048) throw new Error('invalid source directory')
      const source = body.sourceDirectory.trim()
      const manifest = readInstalledManifest(profile, name, root) as { name?: string } | null
      const record: PluginProvenance = {
        category: body.category === 'auto' ? undefined : body.category,
        sourceDirectory: source === '' ? undefined : validateSourceDirectory(source, manifest?.name ?? name),
      }
      writeProvenance(root, name, record)
      sendJson(response, 200, { ok: true, plugin: installedLocation(root, name, spec, record) })
    }),
    route('/dsh-market/open-plugin-folder', 'POST', async (request, response) => {
      if (!localFolderRequest(request)) return sendJson(response, 403, { error: '请在运行 DSH 的电脑上打开目录。远程请求不会打开服务器文件夹。 / Open folders on the computer running DSH, not through a remote connection.' })
      const body = await readJsonBody(request) as Record<string, unknown>
      const { name, spec } = installedSpec(body?.name)
      const location = installedLocation(root, name, spec, readProvenance(root)[name])
      const path = locationTarget(location, body.target)
      if (path === undefined) throw new Error('目录不可用，请刷新或重新关联源码。 / Folder is unavailable. Refresh or relink the source folder.')
      try { await openFolder(path) } catch {
        throw new Error('文件管理器未能启动。请在系统中手动打开目录后重试。 / The file manager could not start. Open the folder manually in your system and retry.')
      }
      sendJson(response, 200, { ok: true })
    }),
  ]
}
