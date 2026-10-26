import { useEffect, useState } from 'react'
import { Button, Input, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconCodeOutline16, IconFolderOpen16 } from './icons.ts'
import { api, localizeBilingual, type Translate } from './market-data.ts'
import { SOURCE_CATEGORIES, sourceCategory, type InstalledSource, type InstalledSources, type SourceCategory, type SourceChoice } from '../plugin-provenance.ts'
import css from './InstalledSourceTools.module.css'
import { UpstreamFields, UpstreamObservation } from './UpstreamTools.tsx'
import type { UpstreamTracking } from '../upstream-types.ts'

export const sourceLabel = (category: SourceCategory): string => 'source' + category.charAt(0).toUpperCase() + category.slice(1)

export function useInstalledSources(installed: Record<string, string>) {
  const [data, setData] = useState<InstalledSources | null>(null)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const identity = JSON.stringify(installed)
  const followsUpstream = Object.values(data?.plugins ?? {}).some(plugin => plugin.upstream !== undefined)
  useEffect(() => {
    if (!followsUpstream) return
    const poll = setInterval(() => { if (!document.hidden) setRevision(value => value + 1) }, 60_000)
    const visible = () => { if (!document.hidden) setRevision(value => value + 1) }
    document.addEventListener('visibilitychange', visible)
    return () => { clearInterval(poll); document.removeEventListener('visibilitychange', visible) }
  }, [followsUpstream])
  useEffect(() => {
    const controller = new AbortController()
    fetch(api('/dsh-market/installed-tools'), { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        const body = await response.json()
        if (!response.ok || body.plugins === null || typeof body.plugins !== 'object' || Array.isArray(body.plugins)
          || Object.values(body.plugins).some(value => value === null || typeof value !== 'object'
            || !SOURCE_CATEGORIES.includes((value as InstalledSource).category))) throw new Error(body.error || `HTTP ${response.status}`)
        if (!controller.signal.aborted) { setData(body); setError('') }
      })
      .catch(error => { if (!controller.signal.aborted) setError(String(error.message || error)) })
    return () => controller.abort()
  }, [identity, revision])
  return { data, error, refresh: () => setRevision(value => value + 1) }
}

export function SourceFilter({ value, onChange, t }: { value: 'all' | SourceCategory; onChange(value: 'all' | SourceCategory): void; t: Translate }) {
  return <select className={css.filter} aria-label={t('sourceFilter')} value={value} onChange={event => onChange(event.target.value as 'all' | SourceCategory)}>
    <option value="all">{t('sourceAll')}</option>
    {SOURCE_CATEGORIES.map(category => <option key={category} value={category}>{t(sourceLabel(category))}</option>)}
  </select>
}

async function postSource(route: string, body: unknown) {
  const response = await fetch(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const result = await response.json()
  if (!response.ok || result.ok !== true) throw new Error(result.error || `HTTP ${response.status}`)
}

export function InstalledSourceTools({ name, spec, source, canOpen, onEdit, onRefresh = () => {}, t, lang }: {
  name: string; spec: string; source?: InstalledSource; canOpen: boolean
  onEdit(): void; onRefresh?(): void; t: Translate; lang: 'zh' | 'en'
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const category = source?.category ?? sourceCategory(spec)
  const open = async (target: 'installed' | 'source' | 'archive') => {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      await postSource(api('/dsh-market/open-plugin-folder'), { name, target })
      setNotice(t('sourceOpenSent'))
    } catch (error) { setError(localizeBilingual(String((error as Error).message), lang)) }
    finally { setBusy(false) }
  }
  const folderButton = (target: 'installed' | 'source' | 'archive', label: string) => (
    <Tooltip key={target} label={canOpen ? label : t('sourceLocalOnly')}>
      <span><Button variant="ghost" size="sm" aria-label={`${label} ${name}`} disabled={busy || !canOpen} onClick={() => open(target)} icon={<IconFolderOpen16 size={14} />} /></span>
    </Tooltip>
  )
  return <div className={css.root} data-plugin-source={name}>
    <div className={css.row}>
      <span className={css.category}>{t(sourceLabel(category))}</span>
      {source?.installedDirectory !== undefined && folderButton('installed', t('sourceOpenInstalled'))}
      {source?.sourceDirectory !== undefined && folderButton('source', t('sourceOpenSource'))}
      {source?.archive !== undefined && folderButton('archive', t('sourceOpenArchive'))}
      <Tooltip label={t('sourceManage')}><span><Button variant="ghost" size="sm" aria-label={`${t('sourceManage')} ${name}`} onClick={onEdit} icon={<IconCodeOutline16 size={14} />} disabled={busy || source === undefined} /></span></Tooltip>
    </div>
    {error !== '' && <div className={css.error} role="alert">{error}</div>}
    {notice !== '' && <div className={css.notice} role="status">{notice}</div>}
    {source?.upstream && <UpstreamObservation name={name} tracking={source.upstream} status={source.upstreamStatus} onRefresh={onRefresh} t={t} lang={lang} />}
  </div>
}

/** Mounted outside the masonry: moving a card must not discard an open draft. */
export function InstalledSourceEditor({ name, source, onSaved, onClose, t, lang }: {
  name: string; source?: InstalledSource; onSaved(): void; onClose(): void; t: Translate; lang: 'zh' | 'en'
}) {
  const [choice, setChoice] = useState<SourceChoice>(source?.choice ?? 'auto')
  const [directory, setDirectory] = useState(source?.sourceDirectory ?? '')
  const [upstream, setUpstream] = useState<UpstreamTracking | undefined>(source?.upstream)
  const [expectedUpstream] = useState(source?.upstream ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = async () => {
    if (busy) return
    setBusy(true); setError('')
    try {
      await postSource(api('/dsh-market/plugin-provenance'), { name, category: choice, sourceDirectory: directory, upstream: upstream ?? null, expectedUpstream })
      onSaved(); onClose()
    } catch (error) { setError(localizeBilingual(String((error as Error).message), lang)) }
    finally { setBusy(false) }
  }
  return <Modal open className={css.editor} title={`${t('sourceManage')} · ${name}`} onClose={() => { if (!busy) onClose() }} footer={<>
      <Button variant="ghost" disabled={busy} onClick={onClose}>{t('cancel')}</Button>
      <Button variant="primary" disabled={busy} onClick={save}>{t('sourceSave')}</Button>
    </>}>
      <div className={css.form}>
        <label>{t('sourceFilter')}<select className={css.filter} value={choice} onChange={event => setChoice(event.target.value as SourceChoice)} disabled={busy}>
          <option value="auto">{t('sourceAuto')}</option>
          {SOURCE_CATEGORIES.filter(category => category !== 'unclassified').map(category => <option value={category} key={category}>{t(sourceLabel(category))}</option>)}
        </select></label>
        <label>{t('sourceDirectory')}<Input value={directory} maxLength={2048} onChange={event => setDirectory(event.target.value)} disabled={busy} /></label>
        <UpstreamFields value={upstream} onChange={setUpstream} disabled={busy} t={t} />
        {source?.sourceMissing === true && <div role="alert" className={css.error}>{t('sourceMissing')}</div>}
        {source?.installedDirectory !== undefined && <div><div className={css.label}>{t('sourceInstalledDirectory')}</div><div className={css.path}>{source.installedDirectory}</div></div>}
        {source?.archive !== undefined && <div><div className={css.label}>{t('sourceArchive')}</div><div className={css.path}>{source.archive}</div></div>}
        {error !== '' && <div className={css.error} role="alert">{error}</div>}
      </div>
    </Modal>
}
