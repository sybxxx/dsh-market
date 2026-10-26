/** Tracking an upstream never authorizes installing it or advancing the saved baseline. */
export interface UpstreamTracking {
  repository: string
  mode: 'npm' | 'branch'
  packageName?: string
  branch?: string
  baseVersion?: string
  baseCommit?: string
}

export type UpstreamState = 'unchecked' | 'baseline-needed' | 'current' | 'updates' | 'ahead' | 'diverged' | 'error'
export interface UpstreamResult {
  state: UpstreamState
  checkedAt?: string
  latest?: string
  aheadBy?: number
  behindBy?: number
  error?: 'network' | 'rate-limit' | 'not-found' | 'invalid-data' | 'repo-mismatch' | 'storage'
}
export interface UpstreamView {
  result: UpstreamResult
  checking: boolean
  nextCheckAt?: string
  stale?: boolean
  previousSuccess?: UpstreamResult
}

export const MAX_TRACKED_PLUGINS = 32
const PACKAGE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/
const SHA = /^[0-9a-f]{40}$/i
export function githubRepository(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const input = value.trim().replace(/^git\+/, '').replace(/^git@github\.com:/, 'https://github.com/')
  const match = /^(?:https:\/\/github\.com\/)?([A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*?)(?:\.git)?\/?$/.exec(input)
  return match === null ? null : match[1]!.toLowerCase()
}

export function parseUpstream(value: unknown): UpstreamTracking | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('上游设置格式不正确，请重新填写。 / Invalid upstream settings. Re-enter the association.')
  const v = value as Record<string, unknown>
  const repository = githubRepository(v.repository)
  if (repository === null || repository.length > 200 || (v.mode !== 'npm' && v.mode !== 'branch')) throw new Error('原项目仓库不正确，请填写 GitHub 仓库地址。 / Invalid upstream repository or mode. Enter the original GitHub repository.')
  const text = (name: string): string | undefined => {
    if (v[name] === undefined || v[name] === '') return undefined
    if (typeof v[name] !== 'string' || v[name].length > 256) throw new Error('上游字段过长或格式不正确，请核对。 / An upstream field is too long or invalid. Review the settings.')
    return v[name].trim() || undefined
  }
  const baseVersion = text('baseVersion'), baseCommit = text('baseCommit')
  if (baseVersion !== undefined && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(baseVersion)) throw new Error('已合并版本格式不正确，请填写具体版本号。 / Invalid upstream baseline version. Enter a specific version.')
  if (baseCommit !== undefined && !SHA.test(baseCommit)) throw new Error('已合并提交不完整，请填写 40 位提交编号。 / Upstream baseline commit needs a full 40-character SHA.')
  if (v.mode === 'npm') {
    const packageName = text('packageName')
    if (packageName === undefined || packageName.length > 214 || !PACKAGE.test(packageName)) throw new Error('发布包名不正确，请核对原项目的 npm 包名。 / Invalid upstream npm package. Check the original npm package name.')
    return { repository, mode: 'npm', packageName, ...(baseVersion ? { baseVersion } : {}), ...(baseCommit ? { baseCommit: baseCommit.toLowerCase() } : {}) }
  }
  const branch = text('branch')
  if (!branch || !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(branch) || branch.includes('..')
    || branch.includes('//') || branch.endsWith('/') || branch.endsWith('.') || branch.endsWith('.lock')) throw new Error('分支名不正确，请填写原仓库的分支名。 / Invalid upstream branch. Enter a branch from the original repository.')
  return { repository, mode: 'branch', branch, ...(baseVersion ? { baseVersion } : {}), ...(baseCommit ? { baseCommit: baseCommit.toLowerCase() } : {}) }
}

export function upstreamKey(tracking: UpstreamTracking): string {
  return JSON.stringify(parseUpstream(tracking))
}

export function upstreamHasPending(view?: UpstreamView): boolean {
  const result = view?.result.state === 'error' ? view.previousSuccess : view?.result
  return result?.state === 'updates' || result?.state === 'diverged'
}

export function upstreamLink(tracking: UpstreamTracking, result?: UpstreamResult): string {
  if (tracking.mode === 'npm') return `https://www.npmjs.com/package/${encodeURIComponent(tracking.packageName!)}`
  if (tracking.baseCommit && result?.latest && SHA.test(result.latest)) {
    return `https://github.com/${tracking.repository}/compare/${tracking.baseCommit}...${result.latest}`
  }
  return `https://github.com/${tracking.repository}/commits/${encodeURIComponent(tracking.branch!)}`
}
