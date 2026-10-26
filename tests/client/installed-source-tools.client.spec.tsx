// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InstalledSourceEditor, InstalledSourceTools, SourceFilter, useInstalledSources } from '../../src/client/InstalledSourceTools.tsx'
import { en, zh } from '../../src/client/locales.ts'
import type { InstalledSource } from '../../src/plugin-provenance.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const source: InstalledSource = { category: 'modified', choice: 'modified', installedDirectory: 'C:\\runtime\\plugin', sourceDirectory: 'D:\\source\\plugin', archive: 'C:\\packages\\plugin.tgz' }
const props = () => ({ name: 'test-plugin', spec: 'file:plugin.tgz', source, canOpen: true, onSaved: vi.fn(), t: (key: string) => en[key as keyof typeof en] ?? key, lang: 'en' as const })
function Tools(p: Omit<ReturnType<typeof props>, 'source' | 'lang'> & { source?: InstalledSource; lang: 'zh' | 'en' }) {
  const [editing, setEditing] = useState(false)
  return <><InstalledSourceTools {...p} onEdit={() => setEditing(true)} />
    {editing && <InstalledSourceEditor {...p} onClose={() => setEditing(false)} />}</>
}

describe('installed source tools', () => {
  it('distinguishes installed, source and archive actions; posts identity, never paths', async () => {
    const fetch = vi.fn(async () => new Response('{"ok":true}'))
    vi.stubGlobal('fetch', fetch)
    render(<Tools {...props()} />)
    expect(screen.getByText(en.sourceModified)).toBeTruthy()
    for (const [label, target] of [[en.sourceOpenInstalled, 'installed'], [en.sourceOpenSource, 'source'], [en.sourceOpenArchive, 'archive']]) {
      fireEvent.click(screen.getByRole('button', { name: `${label} test-plugin` }))
      await waitFor(() => expect(fetch).toHaveBeenLastCalledWith('/dsh-market/open-plugin-folder', expect.objectContaining({ body: JSON.stringify({ name: 'test-plugin', target }) })))
      await waitFor(() => expect(screen.getByRole('status').textContent).toBe(en.sourceOpenSent))
    }
  })
  it('saves explicit classification and source association; permits automatic reset', async () => {
    const fetch = vi.fn(async () => new Response('{"ok":true}'))
    vi.stubGlobal('fetch', fetch)
    const p = props()
    render(<Tools {...p} />)
    fireEvent.click(screen.getByRole('button', { name: `${en.sourceManage} test-plugin` }))
    fireEvent.change(screen.getByLabelText(en.sourceFilter), { target: { value: 'original' } })
    fireEvent.change(screen.getByLabelText(en.sourceDirectory), { target: { value: 'E:\\new source' } })
    fireEvent.click(screen.getByRole('button', { name: en.sourceSave }))
    await waitFor(() => expect(p.onSaved).toHaveBeenCalledTimes(1))
    expect(fetch).toHaveBeenLastCalledWith('/dsh-market/plugin-provenance', expect.objectContaining({ body: JSON.stringify({ name: 'test-plugin', category: 'original', sourceDirectory: 'E:\\new source', upstream: null, expectedUpstream: null }) }))
    fireEvent.click(screen.getByRole('button', { name: `${en.sourceManage} test-plugin` }))
    fireEvent.change(screen.getByLabelText(en.sourceFilter), { target: { value: 'auto' } })
    fireEvent.change(screen.getByLabelText(en.sourceDirectory), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: en.sourceSave }))
    await waitFor(() => expect(p.onSaved).toHaveBeenCalledTimes(2))
    expect(fetch).toHaveBeenLastCalledWith('/dsh-market/plugin-provenance', expect.objectContaining({ body: JSON.stringify({ name: 'test-plugin', category: 'auto', sourceDirectory: '', upstream: null, expectedUpstream: null }) }))
  })
  it('keeps the editor and unsaved text when saving fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"Source folder does not match. Select the local source of this plugin."}', { status: 400 })))
    const p = props()
    render(<Tools {...p} />)
    fireEvent.click(screen.getByRole('button', { name: `${en.sourceManage} test-plugin` }))
    fireEvent.change(screen.getByLabelText(en.sourceDirectory), { target: { value: 'D:\\not this plugin' } })
    fireEvent.click(screen.getByRole('button', { name: en.sourceSave }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect((screen.getByLabelText(en.sourceDirectory) as HTMLInputElement).value).toBe('D:\\not this plugin')
    expect(p.onSaved).not.toHaveBeenCalled()
  })
  it('blocks duplicate submission and does not open folders for remote clients', async () => {
    let finish!: (response: Response) => void
    const fetch = vi.fn(() => new Promise<Response>(done => { finish = done }))
    vi.stubGlobal('fetch', fetch)
    render(<Tools {...props()} canOpen={false} />)
    const open = screen.getByRole('button', { name: `${en.sourceOpenInstalled} test-plugin` }) as HTMLButtonElement
    expect(open.disabled).toBe(true)
    fireEvent.click(open); expect(fetch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: `${en.sourceManage} test-plugin` }))
    const save = screen.getByRole('button', { name: en.sourceSave })
    fireEvent.click(save); fireEvent.click(save)
    expect(fetch).toHaveBeenCalledTimes(1)
    await act(async () => finish(new Response('{"ok":true}')))
  })
  it('offers the same categories in both locales and never guesses local authorship', () => {
    render(<Tools {...props()} source={undefined} t={key => zh[key as keyof typeof zh]} lang="zh" />)
    expect(screen.getByText(zh.sourceUnclassified)).toBeTruthy()
    cleanup()
    const changed = vi.fn()
    render(<SourceFilter value="all" onChange={changed} t={key => en[key as keyof typeof en]} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'modified' } })
    expect(changed).toHaveBeenCalledWith('modified')
    expect(screen.getAllByRole('option')).toHaveLength(5)
  })
  it('ignores a stale read when the installed set changes', async () => {
    const pending: Array<(response: Response) => void> = []
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { pending.push(done) })))
    function Probe({ spec }: { spec: string }) {
      const { data } = useInstalledSources({ plugin: spec })
      return <div>{data?.plugins.plugin?.category ?? 'loading'}</div>
    }
    const { rerender } = render(<Probe spec="1.0.0" />)
    rerender(<Probe spec="file:local" />)
    await act(async () => { pending[1]!(new Response('{"canOpen":true,"plugins":{"plugin":{"category":"modified"}}}')) })
    expect(screen.getByText('modified')).toBeTruthy()
    await act(async () => { pending[0]!(new Response('{"canOpen":true,"plugins":{"plugin":{"category":"online"}}}')) })
    expect(screen.queryByText('online')).toBeNull()
  })
})
