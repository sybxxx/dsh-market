import { Button, Input, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState } from 'react'
import { IconRefreshOutline14 } from './icons.ts'
import { api, localizeBilingual, type Translate } from './market-data.ts'
import { upstreamLink, type UpstreamTracking, type UpstreamView } from '../upstream-types.ts'
import css from './InstalledSourceTools.module.css'

export function UpstreamFields({ value, onChange, disabled, t }: {
  value?: UpstreamTracking; onChange(value: UpstreamTracking | undefined): void; disabled: boolean; t: Translate
}) {
  return <fieldset className={css.upstreamFields} disabled={disabled}>
    <legend>{t('upstreamTitle')}</legend>
    <label className={css.toggle}><input type="checkbox" checked={value !== undefined}
      onChange={event => onChange(event.target.checked ? { repository: '', mode: 'npm', packageName: '' } : undefined)} />{t('upstreamFollow')}</label>
    {value !== undefined && <>
      <label>{t('upstreamRepository')}<Input value={value.repository} maxLength={220} onChange={event => onChange({ ...value, repository: event.target.value })} /></label>
      <label>{t('upstreamMode')}<select className={css.filter} value={value.mode} onChange={event => onChange({ ...value, mode: event.target.value as 'npm' | 'branch' })}>
        <option value="npm">{t('upstreamNpm')}</option><option value="branch">{t('upstreamBranch')}</option>
      </select></label>
      {value.mode === 'npm'
        ? <label>{t('upstreamPackage')}<Input value={value.packageName ?? ''} maxLength={214} onChange={event => onChange({ ...value, packageName: event.target.value })} /></label>
        : <label>{t('upstreamBranchName')}<Input value={value.branch ?? ''} maxLength={256} onChange={event => onChange({ ...value, branch: event.target.value })} /></label>}
      <label>{t('upstreamBaseVersion')}<Input value={value.baseVersion ?? ''} maxLength={128} onChange={event => onChange({ ...value, baseVersion: event.target.value })} /></label>
      <label>{t('upstreamBaseCommit')}<Input value={value.baseCommit ?? ''} maxLength={40} onChange={event => onChange({ ...value, baseCommit: event.target.value })} /></label>
    </>}
  </fieldset>
}

export function UpstreamObservation({ name, tracking, status, onRefresh, t, lang }: {
  name: string; tracking: UpstreamTracking; status?: UpstreamView; onRefresh(): void; t: Translate; lang: 'zh' | 'en'
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const result = status?.result ?? { state: 'unchecked' }
  const baseline = tracking.mode === 'npm' ? tracking.baseVersion : tracking.baseCommit?.slice(0, 7)
  const latest = tracking.mode === 'branch' ? result.latest?.slice(0, 7) : result.latest
  const previous = result.state === 'error' && ['updates', 'diverged'].includes(status?.previousSuccess?.state ?? '')
  const key = status?.stale && result.state === 'current' ? 'upstreamStale' : 'upstreamState_' + result.state
  const checkedAt = result.checkedAt && Number.isFinite(Date.parse(result.checkedAt))
    ? new Date(result.checkedAt).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US') : null
  const check = async () => {
    if (busy || status?.checking) return
    setBusy(true); setError('')
    try {
      const response = await fetch(api('/dsh-market/check-upstream'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) })
      const body = await response.json()
      if (!response.ok || body.ok !== true) throw new Error(body.error || `HTTP ${response.status}`)
      onRefresh()
    } catch (error) { setError(localizeBilingual(String((error as Error).message), lang)) }
    finally { setBusy(false) }
  }
  return <div className={css.upstream} data-upstream={name}>
    <div className={css.row}>
      <span className={result.state === 'updates' || result.state === 'diverged' ? css.upstreamPending : css.label}>{t(key)}{latest ? ` · ${latest}` : ''}</span>
      <Tooltip label={t('upstreamCheck')}><span><Button variant="ghost" size="sm" aria-label={`${t('upstreamCheck')} ${name}`} disabled={busy || status?.checking === true} onClick={check} icon={<IconRefreshOutline14 size={14} />} /></span></Tooltip>
      <a href={upstreamLink(tracking, result)} target="_blank" rel="noreferrer">{t('upstreamChanges')}</a>
    </div>
    <div className={css.label}>{t('upstreamBase')}{baseline ? ` · ${baseline}` : ` · ${t('upstreamMissingBase')}`}{tracking.mode === 'branch' ? ` · ${tracking.branch}` : ''}</div>
    {result.aheadBy !== undefined && result.aheadBy > 0 && <div className={css.label}>{t('upstreamCommits').replace('{0}', String(result.aheadBy))}</div>}
    {checkedAt && <div className={css.label}>{t('upstreamChecked')} · {checkedAt}{status?.stale ? ` · ${t('upstreamExpired')}` : ''}</div>}
    {result.state === 'error' && <div className={css.error}>{t('upstreamError_' + (result.error ?? 'network'))}</div>}
    {previous && <div className={css.label}>{t('upstreamPreviousPending')}</div>}
    {error && <div className={css.error} role="alert">{error}</div>}
  </div>
}
