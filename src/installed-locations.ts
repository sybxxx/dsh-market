/** Resolve only known installed packages; never pass a page-supplied path to a shell. */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { loopbackAuthority, sameOrigin } from './http.ts'
import { sourceCategory, type InstalledSource, type PluginProvenance } from './plugin-provenance.ts'

export const PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i

export function localFilePath(root: string, spec: string): string | undefined {
  const match = /^(?:link|file):(.+)$/i.exec(spec)
  if (match === null) return undefined
  let path: string
  try { path = decodeURIComponent(match[1]!) } catch { return undefined }
  // Refuse network/device paths, including percent-encoded spellings.
  if (/^[\\/]{2}/.test(path) || path.includes('\0')) return undefined
  return resolve(root, path)
}

function directory(path: string | undefined): string | undefined {
  if (path === undefined || !isAbsolute(path) || /^[\\/]{2}/.test(path)) return undefined
  try {
    const real = realpathSync(path)
    return !/^[\\/]{2}/.test(real) && statSync(real).isDirectory() ? real : undefined
  } catch { return undefined }
}

function manifestName(path: string): string | undefined {
  try { return (JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) as { name?: string }).name } catch { return undefined }
}

export function validateSourceDirectory(path: string, expectedName: string): string {
  const real = directory(path)
  if (real === undefined || manifestName(real) !== expectedName) {
    throw new Error('源码目录不匹配。请选择同一插件的本地源码目录。 / Source folder does not match. Select the local source of this plugin.')
  }
  return real
}

export function installedLocation(root: string, name: string, spec: string, record?: PluginProvenance): InstalledSource {
  if (!PACKAGE_NAME.test(name)) throw new Error('invalid package name')
  const installedDirectory = directory(join(root, 'node_modules', name))
  const expectedName = installedDirectory === undefined ? name : manifestName(installedDirectory) ?? name
  const local = localFilePath(root, spec)
  // A host-managed generation is a runtime copy, not the author's source tree.
  const generation = /^link:/i.test(spec) && /(?:^|[\\/])\.generations[\\/]live[\\/]/i.test(spec)
  const sourceCandidate = record?.sourceDirectory ?? (generation ? undefined : directory(local))
  let sourceDirectory: string | undefined
  let sourceMissing = false
  if (sourceCandidate !== undefined) {
    try { sourceDirectory = validateSourceDirectory(sourceCandidate, expectedName) } catch { sourceMissing = true }
  }
  let archive: string | undefined
  if (local !== undefined && /\.tgz$/i.test(local)) {
    try { if (statSync(local).isFile()) archive = realpathSync(local) } catch { /* removed archive */ }
  }
  return {
    category: sourceCategory(spec, record), choice: record?.category ?? 'auto',
    installedDirectory, sourceDirectory, sourceMissing,
    archive: archive !== undefined && !/^[\\/]{2}/.test(archive) ? archive : undefined,
  }
}

/** File-manager operations must be initiated on this machine, not over a tunnel. */
export function localFolderRequest(request: IncomingMessage): boolean {
  const { headers, socket } = request
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(socket.remoteAddress ?? '')) return false
  if (headers.forwarded !== undefined || headers['x-forwarded-for'] !== undefined || headers['x-real-ip'] !== undefined) return false
  if (headers.host !== undefined && !loopbackAuthority(headers.host)) return false
  return sameOrigin(request)
}

export function folderCommand(path: string, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  if (platform === 'win32') return { file: join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe'), args: [path] }
  if (platform === 'darwin') return { file: '/usr/bin/open', args: [path] }
  return { file: 'xdg-open', args: [path] }
}

export async function openInstalledFolder(path: string): Promise<void> {
  const real = directory(path)
  if (real === undefined || !existsSync(real)) throw new Error('目录已不存在，请刷新后重试。 / Folder is missing. Refresh and retry.')
  const command = folderCommand(real)
  await new Promise<void>((accept, reject) => {
    const child = spawn(command.file, command.args, { shell: false, stdio: 'ignore', windowsHide: true })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); accept() })
  })
}

export function locationTarget(location: InstalledSource, target: unknown): string | undefined {
  if (target === 'installed') return location.installedDirectory
  if (target === 'source') return location.sourceDirectory
  if (target === 'archive' && location.archive !== undefined) return dirname(location.archive)
  return undefined
}
