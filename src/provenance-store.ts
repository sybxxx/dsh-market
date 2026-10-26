/** Local-only metadata, independent of upstream's state.json writers. */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isSourceChoice, type PluginProvenance } from './plugin-provenance.ts'
import { MAX_TRACKED_PLUGINS, parseUpstream } from './upstream-types.ts'

const MAX_BYTES = 1024 * 1024
const MAX_PLUGINS = 2000
const PACKAGE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i

export function readLocalJson(root: string, file: string): unknown {
  const path = join(root, '.dsh-market', file)
  try {
    if (statSync(path).size > MAX_BYTES) throw new Error('metadata too large')
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`本地记录无法读取，未覆盖原文件。请检查 ${file} 后重试。 / Local records could not be read and were not overwritten. Check ${file} and retry.`)
  }
}

export function writeLocalJson(root: string, file: string, value: unknown): void {
  const text = JSON.stringify(value, null, 2) + '\n'
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('local records too large')
  const dir = join(root, '.dsh-market')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const temporary = join(dir, `${file}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, join(dir, file))
  } finally { rmSync(temporary, { force: true }) }
}

export function readProvenance(root: string): Record<string, PluginProvenance> {
  const value = readLocalJson(root, 'plugin-provenance.json')
  if (value === undefined) return Object.create(null)
  try {
    if (value === null || typeof value !== 'object' || (value as { version?: unknown }).version !== 1) throw new Error('unknown metadata version')
    const plugins = (value as { plugins?: unknown }).plugins
    if (plugins === null || typeof plugins !== 'object' || Array.isArray(plugins) || Object.keys(plugins).length > MAX_PLUGINS) throw new Error('invalid metadata')
    const result: Record<string, PluginProvenance> = Object.create(null)
    for (const [name, record] of Object.entries(plugins)) {
      if (!PACKAGE.test(name) || name === '__proto__' || record === null || typeof record !== 'object' || Array.isArray(record)) throw new Error('invalid plugin metadata')
      const { category, sourceDirectory, upstream } = record as { category?: unknown; sourceDirectory?: unknown; upstream?: unknown }
      if (category !== undefined && (!isSourceChoice(category) || category === 'auto')) throw new Error('invalid category')
      if (sourceDirectory !== undefined && (typeof sourceDirectory !== 'string' || sourceDirectory.length > 2048)) throw new Error('invalid source directory')
      result[name] = { category: category as PluginProvenance['category'], sourceDirectory: sourceDirectory as string | undefined, upstream: parseUpstream(upstream) }
    }
    if (Object.values(result).filter(record => record.upstream).length > MAX_TRACKED_PLUGINS) throw new Error('too many tracked upstreams')
    return result
  } catch {
    throw new Error('来源记录无法读取，未覆盖原文件。请检查 plugin-provenance.json 后重试。 / Source records could not be read and were not overwritten. Check plugin-provenance.json and retry.')
  }
}

export function writeProvenance(root: string, name: string, record: PluginProvenance): void {
  const plugins = readProvenance(root)
  if (record.category === undefined && record.sourceDirectory === undefined && record.upstream === undefined) delete plugins[name]
  else plugins[name] = { ...record, upstream: parseUpstream(record.upstream) }
  if (Object.keys(plugins).length > MAX_PLUGINS) throw new Error('too many source records')
  if (Object.values(plugins).filter(value => value.upstream !== undefined).length > MAX_TRACKED_PLUGINS) {
    throw new Error('最多跟踪 32 个上游。请先取消不再关注的项目。 / Track at most 32 upstreams. Unlink one you no longer follow first.')
  }
  writeLocalJson(root, 'plugin-provenance.json', { version: 1, plugins })
}
