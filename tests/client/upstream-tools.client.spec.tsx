// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpstreamObservation } from '../../src/client/UpstreamTools.tsx'
import { InstalledSourceEditor, useInstalledSources } from '../../src/client/InstalledSourceTools.tsx'
import { en } from '../../src/client/locales.ts'
import type { InstalledSource } from '../../src/plugin-provenance.ts'
import type { UpstreamTracking, UpstreamView } from '../../src/upstream-types.ts'

const tracking: UpstreamTracking = { repository: 'owner/plugin', mode: 'npm', packageName: 'original-package', baseVersion: '5.10.0' }
const t = (key: string) => en[key as keyof typeof en] ?? key
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('upstream observation UI', () => {
  it.each(['unchecked', 'baseline-needed', 'current', 'updates', 'ahead', 'diverged', 'error'] as const)('renders %s without an install/merge action', state => {
    render(<UpstreamObservation name="custom" tracking={tracking} t={t} lang="en" onRefresh={() => {}} status={{ result: { state, latest: '5.10.1', error: state === 'error' ? 'network' : undefined }, checking: false }} />)
    expect(screen.getByText(new RegExp(en[('upstreamState_' + state) as keyof typeof en]))).toBeTruthy()
    expect(screen.getByText('Merged baseline · 5.10.0')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Install|Merge/ })).toBeNull()
  })
  it('does not advertise an expired successful check as current', () => {
    render(<UpstreamObservation name="custom" tracking={tracking} t={t} lang="en" onRefresh={() => {}} status={{ result: { state: 'current', checkedAt: '2026-01-01T00:00:00Z' }, checking: false, stale: true }} />)
    expect(screen.getByText(en.upstreamStale)).toBeTruthy()
    expect(screen.queryByText(en.upstreamState_current)).toBeNull()
  })
  it('retains the previous pending signal after a failed check and uses pinned compare links', () => {
    const branch: UpstreamTracking = { repository: 'owner/plugin', mode: 'branch', branch: 'main', baseCommit: 'a'.repeat(40) }
    const status: UpstreamView = { checking: false, previousSuccess: { state: 'updates', latest: 'b'.repeat(40) }, result: { state: 'error', error: 'rate-limit' } }
    render(<UpstreamObservation name="custom" tracking={branch} status={status} t={t} lang="en" onRefresh={() => {}} />)
    expect(screen.getByText(en.upstreamPreviousPending)).toBeTruthy()
    expect(screen.getByText(en['upstreamError_rate-limit'])).toBeTruthy()
    expect(screen.getByRole('link', { name: en.upstreamChanges }).getAttribute('href')).toBe('https://github.com/owner/plugin/commits/main')
  })
  it('deduplicates clicks, refreshes the observation and never calls the install endpoint', async () => {
    let finish!: (r: Response) => void
    const fetch = vi.fn(() => new Promise<Response>(done => { finish = done }))
    vi.stubGlobal('fetch', fetch)
    const refresh = vi.fn()
    render(<UpstreamObservation name="custom" tracking={tracking} t={t} lang="en" onRefresh={refresh} />)
    const button = screen.getByRole('button', { name: 'Check upstream custom' })
    fireEvent.click(button); fireEvent.click(button)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith('/dsh-market/check-upstream', expect.objectContaining({ body: '{"name":"custom"}' }))
    await act(async () => finish(new Response('{"ok":true}')))
    expect(refresh).toHaveBeenCalledTimes(1)
  })
  it('records upstream separately from the custom version and supports unlinking', async () => {
    const fetch = vi.fn(async () => new Response('{"ok":true}')); vi.stubGlobal('fetch', fetch)
    const saved = vi.fn()
    const source: InstalledSource = { category: 'modified', choice: 'modified', upstream: tracking }
    render(<InstalledSourceEditor name="custom" source={source} t={t} lang="en" onSaved={saved} onClose={() => {}} />)
    expect((screen.getByLabelText(en.upstreamBaseVersion) as HTMLInputElement).value).toBe('5.10.0')
    fireEvent.change(screen.getByLabelText(en.upstreamBaseVersion), { target: { value: '5.10.1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1))
    const body = JSON.parse(fetch.mock.calls[0]![1].body as string)
    expect(body.upstream.baseVersion).toBe('5.10.1'); expect(body.expectedUpstream.baseVersion).toBe('5.10.0')
    fireEvent.click(screen.getByLabelText(en.upstreamFollow))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(2))
    expect(JSON.parse(fetch.mock.calls[1]![1].body as string).upstream).toBeNull()
  })
  it('polls only associated records while mounted and cancels timers on unmount', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(async () => new Response(JSON.stringify({ canOpen: true, plugins: { custom: { category: 'modified', upstream: tracking } } })))
    vi.stubGlobal('fetch', fetch)
    function Probe() { const { data } = useInstalledSources({ custom: 'file:local.tgz' }); return <span>{data ? 'ready' : 'loading'}</span> }
    const { unmount } = render(<Probe />)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    const count = fetch.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(fetch.mock.calls.length).toBe(count + 1)
    unmount(); await vi.advanceTimersByTimeAsync(120_000)
    expect(fetch.mock.calls.length).toBe(count + 1)
  })
})
