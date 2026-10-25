import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mock.spawn }))
import { openInstalledFolder } from '../src/installed-locations.ts'

const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); mock.spawn.mockReset() })

it('opens an existing folder without a shell or a visible helper console', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dshm-folder with spaces-'))
  roots.push(root)
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
  mock.spawn.mockImplementation(() => { queueMicrotask(() => child.emit('spawn')); return child })
  await openInstalledFolder(root)
  expect(mock.spawn).toHaveBeenCalledWith(expect.any(String), [root], { shell: false, stdio: 'ignore', windowsHide: true })
  expect(child.unref).toHaveBeenCalledTimes(1)
})

it('reports launch errors and never spawns for a nonexistent path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dshm-folder-'))
  roots.push(root)
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
  mock.spawn.mockImplementation(() => { queueMicrotask(() => child.emit('error', new Error('file manager missing'))); return child })
  await expect(openInstalledFolder(root)).rejects.toThrow('file manager missing')
  await expect(openInstalledFolder(join(root, 'missing.exe'))).rejects.toThrow('Folder is missing')
  expect(mock.spawn).toHaveBeenCalledTimes(1)
})
