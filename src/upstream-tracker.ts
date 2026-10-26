/** Durable, bounded observation. No Git, package-manager or application-control calls. */
import { readInstalled } from './profile.ts'
import { readLocalJson, readProvenance, writeLocalJson } from './provenance-store.ts'
import { inspectUpstream, UpstreamFailure } from './upstream-network.ts'
import { logEvent } from './log.ts'
import { MAX_TRACKED_PLUGINS, parseUpstream, upstreamKey, type UpstreamResult, type UpstreamTracking, type UpstreamView } from './upstream-types.ts'

const FILE = 'upstream-checks.json'
export const UPSTREAM_INTERVAL_MS = 6 * 60 * 60_000
export const UPSTREAM_RETRY_MS = 30 * 60_000
export const UPSTREAM_MANUAL_MS = 60_000
const MAX_PENDING = 2
interface CheckRecord { key: string; result: UpstreamResult; previousSuccess?: UpstreamResult; nextAt: number }

function readChecks(root: string): Record<string, CheckRecord> {
  const value = readLocalJson(root, FILE) as { version?: unknown; plugins?: Record<string, CheckRecord> } | undefined
  if (value === undefined) return Object.create(null)
  if (!value || value.version !== 1 || !value.plugins || Array.isArray(value.plugins) || typeof value.plugins !== 'object'
    || Object.keys(value.plugins).length > MAX_TRACKED_PLUGINS) throw new Error('Invalid upstream check records')
  for (const record of Object.values(value.plugins)) {
    const validResult = (result: UpstreamResult): boolean => !!result
      && ['baseline-needed', 'current', 'updates', 'ahead', 'diverged', 'error'].includes(result.state)
      && typeof result.checkedAt === 'string' && Number.isFinite(Date.parse(result.checkedAt))
      && (result.latest === undefined || (typeof result.latest === 'string' && result.latest.length <= 256))
      && ['aheadBy', 'behindBy'].every(key => result[key as 'aheadBy'] === undefined
        || (Number.isSafeInteger(result[key as 'aheadBy']) && result[key as 'aheadBy']! >= 0))
      && (result.error === undefined || ['network', 'rate-limit', 'not-found', 'invalid-data', 'repo-mismatch', 'storage'].includes(result.error))
    if (!record || typeof record.key !== 'string' || record.key.length > 2000 || !Number.isFinite(record.nextAt)
      || record.nextAt < 0 || record.nextAt > 8.64e15 || !validResult(record.result)
      || (record.previousSuccess !== undefined && !validResult(record.previousSuccess))) throw new Error('Invalid upstream check records')
    const tracking = parseUpstream(JSON.parse(record.key))
    if (!tracking || upstreamKey(tracking) !== record.key) throw new Error('Invalid upstream check identity')
  }
  return value.plugins
}

export class UpstreamTracker {
  private readonly controller = new AbortController()
  private readonly pending = new Map<string, Promise<UpstreamView>>()
  private readonly providerHold = new Map<string, number>()
  private readonly storageFailures = new Map<string, CheckRecord>()
  private initial?: ReturnType<typeof setTimeout>
  private interval?: ReturnType<typeof setInterval>
  private roundRunning = false
  constructor(private readonly root: string, private readonly profile: string,
    private readonly inspect = inspectUpstream, private readonly now = Date.now) {}

  private associations() {
    const records = readProvenance(this.root)
    for (const [name, failure] of this.storageFailures) {
      if (!records[name]?.upstream || upstreamKey(records[name].upstream!) !== failure.key) this.storageFailures.delete(name)
    }
    return records
  }

  views(): Record<string, UpstreamView> {
    const records = this.associations()
    let checks: Record<string, CheckRecord>
    try { checks = readChecks(this.root) } catch {
      return Object.fromEntries(Object.entries(records).filter(([, r]) => r.upstream).map(([name]) => [name, { result: { state: 'error', error: 'storage' }, checking: false }]))
    }
    return Object.fromEntries(Object.entries(records).filter(([, r]) => r.upstream).map(([name, record]) => {
      const tracking = record.upstream!
      const volatile = this.storageFailures.get(name)
      const check = volatile?.key === upstreamKey(tracking) ? volatile : checks[name]
      return [name, check?.key === upstreamKey(tracking)
        ? { result: check.result, previousSuccess: check.previousSuccess, checking: this.pending.has(name), nextCheckAt: new Date(check.nextAt).toISOString(), stale: this.now() >= check.nextAt }
        : { result: { state: 'unchecked' }, checking: this.pending.has(name) }]
    }))
  }

  async check(name: string, manual = false): Promise<UpstreamView> {
    if (this.controller.signal.aborted) throw new Error('Upstream tracker stopped')
    const tracking = this.associations()[name]?.upstream
    if (!tracking || !Object.hasOwn(readInstalled(this.profile, this.root), name)) throw new Error('请先关联已安装插件的上游。 / Link an installed plugin to its upstream first.')
    const key = upstreamKey(tracking)
    const pending = this.pending.get(name)
    if (pending) return pending
    let records: Record<string, CheckRecord>
    try { records = readChecks(this.root) } catch {
      throw new Error('本地检查记录无法读取，已停止检查。请保留记录并联系维护者。 / Local check records could not be read. Preserve them and contact the maintainer.')
    }
    const old = this.storageFailures.get(name) ?? records[name], now = this.now()
    if (old && ((old.key === key && !manual && now < old.nextAt)
      || (old.key === key && old.result.error === 'rate-limit' && now < old.nextAt)
      || (manual && now - Date.parse(old.result.checkedAt!) < UPSTREAM_MANUAL_MS))) {
      if (old.key !== key) throw new Error('检查过于频繁，请稍后重试。 / Checks are too frequent. Retry in a minute.')
      return this.views()[name]!
    }
    if (this.pending.size >= MAX_PENDING) throw new Error('正在检查其他上游，请稍后重试。 / Other upstreams are being checked. Retry shortly.')
    const persistedHold = Object.values(records).some(record => record.result.error === 'rate-limit' && now < record.nextAt
      && parseUpstream(JSON.parse(record.key))?.mode === tracking.mode)
    if ((this.providerHold.get(tracking.mode) ?? 0) > now || persistedHold) throw new Error('上游暂时限制了请求，请稍后重试。 / Upstream requests are temporarily limited. Retry later.')
    const operation = this.perform(name, tracking, key, old)
    this.pending.set(name, operation)
    try { return await operation } finally { this.pending.delete(name) }
  }

  private async perform(name: string, tracking: UpstreamTracking, key: string, old?: CheckRecord): Promise<UpstreamView> {
    let result: UpstreamResult
    let wait = UPSTREAM_INTERVAL_MS
    const deadline = AbortSignal.timeout(15_000)
    const signal = AbortSignal.any([deadline, this.controller.signal])
    try {
      result = await this.inspect(tracking, signal)
      if (signal.aborted) throw new UpstreamFailure('network')
    } catch (error) {
      if (this.controller.signal.aborted) throw new Error('Upstream tracker stopped')
      const failure = error instanceof UpstreamFailure ? error : new UpstreamFailure('network')
      wait = Math.max(UPSTREAM_RETRY_MS, failure.waitMs)
      if (failure.code === 'rate-limit') this.providerHold.set(tracking.mode, this.now() + wait)
      result = { state: 'error', error: failure.code }
    }
    if (signal.aborted && this.controller.signal.aborted) throw new Error('Upstream tracker stopped')
    // Never let a response for an old association advance a newly edited baseline.
    const live = readProvenance(this.root)
    if (!Object.hasOwn(readInstalled(this.profile, this.root), name) || !live[name]?.upstream || upstreamKey(live[name].upstream!) !== key) throw new Error('上游关联已改变，请重新检查。 / Upstream association changed. Check again.')
    const previousSuccess = result.state === 'error' && old?.key === key
      ? (old.result.state !== 'error' ? old.result : old.previousSuccess) : undefined
    result = { ...result, checkedAt: new Date(this.now()).toISOString() }
    const records = readChecks(this.root)
    // Drop observations, not user associations, for unlinked/uninstalled packages.
    const installed = readInstalled(this.profile, this.root)
    const kept = Object.fromEntries(Object.entries(records).filter(([n]) => live[n]?.upstream && Object.hasOwn(installed, n)))
    kept[name] = { key, result, previousSuccess, nextAt: this.now() + wait }
    try {
      writeLocalJson(this.root, FILE, { version: 1, plugins: kept })
      this.storageFailures.delete(name)
    } catch {
      const failure: CheckRecord = { key, result: { state: 'error', error: 'storage', checkedAt: result.checkedAt }, previousSuccess: old?.key === key ? (old.result.state === 'error' ? old.previousSuccess : old.result) : undefined, nextAt: this.now() + UPSTREAM_RETRY_MS }
      this.storageFailures.set(name, failure)
      logEvent('warn', 'upstream-check', `${name}: error (storage)`)
      return { result: failure.result, previousSuccess: failure.previousSuccess, checking: false, nextCheckAt: new Date(failure.nextAt).toISOString() }
    }
    logEvent(result.state === 'error' ? 'warn' : 'info', 'upstream-check', `${name}: ${result.state}${result.error ? ` (${result.error})` : ''}`)
    return { result, previousSuccess, checking: false, nextCheckAt: new Date(kept[name].nextAt).toISOString(), stale: false }
  }

  async sweep(): Promise<void> {
    if (this.roundRunning || this.controller.signal.aborted) return
    this.roundRunning = true
    try {
      const names = Object.entries(readProvenance(this.root)).filter(([, r]) => r.upstream).map(([n]) => n).slice(0, MAX_TRACKED_PLUGINS)
      let index = 0
      const worker = async () => {
        while (!this.controller.signal.aborted && index < names.length) {
          const name = names[index++]!
          try { await this.check(name) } catch { /* Per-row error or cooldown; never install as a fallback. */ }
        }
      }
      await Promise.all([worker(), worker()])
    } finally { this.roundRunning = false }
  }

  start(): void {
    if (this.initial || this.controller.signal.aborted) return
    this.initial = setTimeout(() => { void this.sweep().catch(() => {}) }, 15_000)
    this.interval = setInterval(() => { void this.sweep().catch(() => {}) }, UPSTREAM_RETRY_MS)
    this.initial.unref?.(); this.interval.unref?.()
  }
  stop(): void {
    clearTimeout(this.initial); clearInterval(this.interval); this.controller.abort()
  }
}
