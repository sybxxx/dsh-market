import assert from 'node:assert/strict'
import { createServer as createViteServer } from 'vite'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mountInstalledManagement, writeProvenance } from '../lib/installed-management.js'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const root = await mkdtemp(join(tmpdir(), 'dshm-source-browser-'))
const output = resolve('output/playwright')
const routes = new Map()
const opened = []
let vite
let browser
const installed = { 'online-plugin': '1.0.0', 'original-plugin': 'file:./source', 'fork-plugin': 'file:./package.tgz' }
const json = (res, data) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)) }
try {
  await mkdir(output, { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: installed }))
  await mkdir(join(root, 'source'))
  await writeFile(join(root, 'source', 'package.json'), '{"name":"original-plugin"}')
  await writeFile(join(root, 'package.tgz'), 'inert archive')
  for (const name of Object.keys(installed)) {
    await mkdir(join(root, 'node_modules', name), { recursive: true })
    await writeFile(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
  }
  writeProvenance(root, 'original-plugin', { category: 'original' })
  mountInstalledManagement(route => { routes.set(route.path, route.handler); return () => routes.delete(route.path) }, root, 'web', async path => { opened.push(path) })
  vite = await createViteServer({ configFile: false, server: { host: '127.0.0.1', port: 0 }, appType: 'custom',
    plugins: [{ name: 'disposable-market-fixture', configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = req.url.split('?')[0]
        if (routes.has(path)) { await routes.get(path)(req, res); return }
        if (path === '/') {
          const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Installed plugins test</title><style>html,body{margin:0;height:100%;font:14px Arial,sans-serif;background:#151515;color:#ddd;--dsw-alias-label-primary:#ddd;--dsw-alias-label-secondary:#b0b0b0;--dsw-alias-label-tertiary:#929292;--dsw-alias-bg-base:#151515;--dsw-alias-bg-layer-1:#222;--dsw-alias-bg-layer-2:#292929;--dsw-alias-bg-module-platform:#222;--dsw-alias-border-secondary:#555;--dsw-alias-settings-card-fill:#222;--dsw-alias-settings-card-stroke:#444}*{box-sizing:border-box}#root{max-width:1120px;height:100%;margin:auto;padding:20px}button,input,select{font:inherit}button{cursor:pointer}input{max-width:100%}</style></head><body><div id="root"></div><script type="module" src="/tests/fixtures/source-tools-preview.tsx"></script></body></html>'
          res.setHeader('content-type', 'text/html'); res.end(await server.transformIndexHtml(req.url, html)); return
        }
        if (path === '/dsh-market/registry') return json(res, { registry: { updated: '', count: 1, plugins: [{ name: 'online-plugin', owner: 'fixture', url: 'https://github.com/fixture/online-plugin', category: 'tools', description: { zh: '线上安装', en: 'Online installation' } }], categories: { tools: { zh: '工具', en: 'Tools' } } } })
        if (path === '/dsh-market/installed') return json(res, { installed, present: Object.keys(installed), groups: { Local: ['original-plugin', 'fork-plugin'] }, groupOrder: ['Local'], live: [], disabled: [], activation: {} })
        if (path === '/dsh-market/updates') return json(res, { updates: Object.fromEntries(Object.keys(installed).map(name => [name, { version: '1.0.0', kind: name === 'online-plugin' ? 'npm' : 'linked' }])) })
        if (path === '/dsh-market/status') return json(res, { pnpm: true, active: false, installed, boot: 'fixture', version: '1.70.2-sybxxx.1' })
        if (path.startsWith('/dsh-market/')) return json(res, {})
        next()
      })
    } }],
  })
  await vite.listen()
  const url = `http://127.0.0.1:${vite.httpServer.address().port}`
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) })
  const page = await browser.newPage()
  const errors = []
  const blocked = new Set()
  page.on('pageerror', error => errors.push(String(error)))
  page.on('console', message => { if (message.type() === 'error' && !blocked.has(message.location().url)) errors.push(message.text()) })
  await page.route('**/*', route => {
    if (route.request().url().startsWith(url + '/')) return route.continue()
    blocked.add(route.request().url()); return route.abort()
  })
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
    await page.getByRole('button', { name: /^已安装/ }).click()
    await page.locator('[data-plugin-source="original-plugin"]').waitFor()
    const fork = page.locator('[data-plugin-source="fork-plugin"]')
    await fork.getByRole('button', { name: '来源与目录 fork-plugin' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('来源分类').selectOption('modified')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await page.getByRole('combobox', { name: '来源分类' }).selectOption('modified')
    await page.waitForFunction(() => document.querySelectorAll('[data-plugin-source]').length === 1)
    await fork.getByRole('button', { name: '打开安装目录 fork-plugin' }).click()
    await fork.getByRole('status').waitFor()
    assert.equal(opened.at(-1), join(root, 'node_modules', 'fork-plugin'))
    await page.getByRole('combobox', { name: '来源分类' }).selectOption('all')
    await page.mouse.move(0, 0)
    await page.evaluate(() => document.activeElement?.blur())
    await page.screenshot({ path: join(output, `installed-sources-${width}.png`), fullPage: true })
    await page.getByRole('button', { name: '来源与目录 original-plugin' }).click()
    await page.getByRole('dialog').waitFor()
    const draft = await page.getByRole('dialog').getByLabel('关联源码目录').inputValue()
    await page.setViewportSize({ width: width === 1280 ? 900 : 420, height: 900 })
    assert.equal(await page.getByRole('dialog').getByLabel('关联源码目录').inputValue(), draft)
    await page.setViewportSize({ width, height: 900 })
    await page.screenshot({ path: join(output, `installed-source-editor-${width}.png`), fullPage: true })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: '分组', exact: true }).click()
    await page.screenshot({ path: join(output, `installed-source-groups-${width}.png`), fullPage: true })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
  }
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(url + '/?lang=en', { waitUntil: 'networkidle', timeout: 60_000 })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  await page.getByRole('button', { name: /^Installed/ }).click()
  await page.getByRole('button', { name: 'Source and folders original-plugin' }).click()
  await page.getByRole('dialog').waitFor()
  await page.screenshot({ path: join(output, 'installed-source-editor-light-en.png'), fullPage: true })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
  assert.equal(JSON.parse(await readFile(join(root, '.dsh-market', 'plugin-provenance.json'), 'utf8')).plugins['fork-plugin'].category, 'modified')
  assert.deepEqual(errors, [])
  process.stdout.write('Source tools browser checks passed: real UI + disposable profile routes, desktop/mobile, save/filter/open/group, no provider calls.\n')
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0]
  if (page) {
    await page.screenshot({ path: join(output, 'source-tools-failure.png'), fullPage: true })
    const positions = await page.locator('[role="dialog"], [role="dialog"] button').evaluateAll(elements => elements.map(element => ({ text: element.textContent.slice(0, 80), rect: element.getBoundingClientRect().toJSON() })))
    process.stderr.write(JSON.stringify(positions) + '\n')
  }
  throw error
} finally {
  await browser?.close()
  await vite?.close()
  await rm(root, { recursive: true, force: true })
}
