/** Local display metadata has its own file, so ordinary market writes cannot erase it. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readJsonBody, sameOrigin, sendJson } from './http.ts'
import { readInstalled, readInstalledManifest } from './profile.ts'
import { installedLocation, localFolderRequest, locationTarget, openInstalledFolder, PACKAGE_NAME, validateSourceDirectory } from './installed-locations.ts'
import { isSourceChoice, type InstalledSources, type PluginProvenance } from './plugin-provenance.ts'
import type { WebServerService } from './routes.ts'
import { readProvenance, writeProvenance } from './provenance-store.ts'
import { parseUpstream, upstreamKey } from './upstream-types.ts'
import { UpstreamTracker } from './upstream-tracker.ts'
export { readProvenance, writeProvenance } from './provenance-store.ts'

export function installedSources(root: string, profile: string, request: IncomingMessage, tracker?: UpstreamTracker): InstalledSources {
  const records = readProvenance(root)
  const statuses = tracker?.views() ?? {}
  const plugins = Object.fromEntries(Object.entries(readInstalled(profile, root))
    .map(([name, spec]) => [name, { ...installedLocation(root, name, spec, records[name]), upstream: records[name]?.upstream, upstreamStatus: statuses[name] }]))
  return { plugins, canOpen: localFolderRequest(request) }
}

export function mountInstalledManagement(
  register: WebServerService['register'], root: string, profile: string,
  openFolder = openInstalledFolder,
  tracker = new UpstreamTracker(root, profile),
): Array<() => void> {
  tracker.start()
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
    () => tracker.stop(),
    route('/dsh-market/installed-tools', 'GET', (request, response) => {
      sendJson(response, 200, installedSources(root, profile, request, tracker))
    }),
    route('/dsh-market/plugin-provenance', 'POST', async (request, response) => {
      const body = await readJsonBody(request) as Record<string, unknown>
      const { name, spec } = installedSpec(body?.name)
      if (!isSourceChoice(body.category)) throw new Error('invalid category')
      if (typeof body.sourceDirectory !== 'string' || body.sourceDirectory.length > 2048) throw new Error('invalid source directory')
      const source = body.sourceDirectory.trim()
      const manifest = readInstalledManifest(profile, name, root) as { name?: string } | null
      const existing = readProvenance(root)[name]?.upstream
      if (Object.hasOwn(body, 'expectedUpstream')) {
        const expected = parseUpstream(body.expectedUpstream)
        if ((expected ? upstreamKey(expected) : null) !== (existing ? upstreamKey(existing) : null)) {
          throw new Error('上游记录已在别处修改。请重新打开此设置，核对后保存。 / Upstream records changed elsewhere. Reopen these settings, review them and save again.')
        }
      }
      const record: PluginProvenance = {
        category: body.category === 'auto' ? undefined : body.category,
        sourceDirectory: source === '' ? undefined : validateSourceDirectory(source, manifest?.name ?? name),
        upstream: Object.hasOwn(body, 'upstream') ? parseUpstream(body.upstream) : existing,
      }
      writeProvenance(root, name, record)
      sendJson(response, 200, { ok: true, plugin: { ...installedLocation(root, name, spec, record), upstream: record.upstream } })
    }),
    route('/dsh-market/check-upstream', 'POST', async (request, response) => {
      const body = await readJsonBody(request) as Record<string, unknown>
      const { name } = installedSpec(body?.name)
      const status = await tracker.check(name, true)
      sendJson(response, 200, { ok: true, status })
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
