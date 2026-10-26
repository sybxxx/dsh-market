/** Display identity is independent of the package manager's install source. */
import type { UpstreamTracking, UpstreamView } from './upstream-types.ts'
export const SOURCE_CATEGORIES = ['online', 'original', 'modified', 'unclassified'] as const
export type SourceCategory = typeof SOURCE_CATEGORIES[number]
export type SourceChoice = 'auto' | Exclude<SourceCategory, 'unclassified'>

export interface PluginProvenance {
  category?: Exclude<SourceCategory, 'unclassified'>
  sourceDirectory?: string
  upstream?: UpstreamTracking
}

export interface InstalledSource {
  category: SourceCategory
  choice: SourceChoice
  sourceDirectory?: string
  installedDirectory?: string
  archive?: string
  sourceMissing?: boolean
  upstream?: UpstreamTracking
  upstreamStatus?: UpstreamView
}

export interface InstalledSources {
  plugins: Record<string, InstalledSource>
  canOpen: boolean
}

export function isSourceChoice(value: unknown): value is SourceChoice {
  return value === 'auto' || value === 'online' || value === 'original' || value === 'modified'
}

export function sourceCategory(spec: string, record?: PluginProvenance): SourceCategory {
  if (record?.category !== undefined) return record.category
  // Desktop-managed production generations also use link:, but are not local work.
  if (/^link:/i.test(spec) && /(?:^|[\\/])\.generations[\\/]live[\\/]/i.test(spec)) return 'online'
  return /^(?:link|file):/i.test(spec) ? 'unclassified' : 'online'
}
