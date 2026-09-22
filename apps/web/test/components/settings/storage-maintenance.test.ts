import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"

let browser: Browser
let page: Page
let server: ViteDevServer
let root: string
let url: string

beforeAll(async () => {
  root = await mkdtemp(path.join(import.meta.dir, ".storage-maintenance-"))
  const source = path.resolve(import.meta.dir, "../../../src")
  await Bun.write(path.join(root, "index.html"), '<div id="root"></div><script type="module" src="/main.tsx"></script>')
  await Bun.write(
    path.join(root, "main.tsx"),
    `
    import { setupI18n } from "@lingui/core"
    import { I18nProvider } from "@lingui/solid"
    import { createSignal } from "solid-js"
    import { render } from "solid-js/web"
    import { StorageMaintenance } from ${JSON.stringify(`/@fs/${source}/components/settings/panels/StorageMaintenance.tsx`)}
    const mode = new URL(location.href).searchParams.get('mode')
    const i18n = setupI18n({locale: 'en', messages: {}})
    const [paused, setPaused] = createSignal(false)
    let running = false
    let finish
    window.calls = []
    const status = () => ({mode: 'managed', maintenance: {state: running ? 'running' : 'idle', progress: {step: 2, current: 512, total: 0}}})
    const bridge = mode === 'web' ? undefined : {
      status: async () => status(),
      maintenance: async (operation) => { window.calls.push(operation === 'prune' ? 'prune' : 'maintenance'); if (mode === 'failure') throw new Error('Wait for the active task'); running = true; await new Promise(resolve => finish = resolve); return status() },
      cancelMaintenance: async () => { window.calls.push('return'); running = false; finish?.(); return status() },
    }
    render(() => <I18nProvider i18n={i18n}><StorageMaintenance
      status={{format: {maintenanceRequired: true, current: 2, target: 3}, reclaim: {pending: true, paused: paused(), running: false}, prune: {owners: mode === 'prune' || mode === 'web' ? 2 : 0, updatedAt: 1}}}
      loading={false} bridge={bridge} controlBusy={false} onRefresh={() => {}}
      onControl={action => { window.calls.push(action); setPaused(action === 'pause') }}
    /></I18nProvider>, document.querySelector('#root'))
  `,
  )
  server = await createServer({
    configFile: false,
    root,
    plugins: [solidPlugin()],
    resolve: { alias: { "@": source } },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [path.resolve(import.meta.dir, "../../../../..")] } },
  })
  await server.listen()
  url = server.resolvedUrls!.local[0]!
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 375, height: 700 } })
}, 30_000)

afterAll(async () => {
  await page?.close()
  await browser?.close()
  await server?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

test("managed maintenance reports unknown totals and allows returning while its request is pending", async () => {
  await page.goto(url)
  await page.getByRole("button", { name: "Optimize storage", exact: true }).click()
  await page.getByText("Step 2: 512 processed.", { exact: false }).waitFor()
  await page.getByRole("button", { name: "Return to Synergy", exact: true }).click()
  await page.getByRole("button", { name: "Optimize storage", exact: true }).waitFor()
  expect(await page.evaluate<string[]>("window.calls")).toEqual(["maintenance", "return"])
  await page.getByRole("button", { name: "Pause", exact: true }).click()
  await page.getByRole("button", { name: "Resume", exact: true }).click()
  expect(await page.evaluate<string[]>("window.calls")).toEqual(["maintenance", "return", "pause", "resume"])
}, 15_000)

test("active-work rejection leaves the maintenance action available", async () => {
  await page.goto(url + "?mode=failure")
  await page.getByRole("button", { name: "Optimize storage", exact: true }).click()
  await page.getByRole("alert").waitFor()
  expect(await page.getByRole("alert").textContent()).toBe("Wait for the active task")
  expect(await page.getByRole("button", { name: "Optimize storage", exact: true }).isEnabled()).toBe(true)
})

test("web mode explains host-side maintenance without exposing a local stop action", async () => {
  await page.goto(url + "?mode=web")
  await page.getByText("synergy migration run storage --maintenance", { exact: true }).waitFor()
  expect(await page.getByRole("button", { name: "Optimize storage", exact: true }).count()).toBe(0)
  expect(await page.getByRole("button", { name: "Return to Synergy", exact: true }).count()).toBe(0)
  await page.getByText("synergy data storage prune", { exact: true }).waitFor()
})

test("large expired evidence has an explicit maintenance action with its data consequences", async () => {
  await page.goto(url + "?mode=prune")
  await page.getByText("Removed evidence cannot be restored.", { exact: false }).waitFor()
  await page.getByRole("button", { name: "Remove expired evidence", exact: true }).click()
  await page.getByRole("button", { name: "Return to Synergy", exact: true }).click()
  expect(await page.evaluate<string[]>("window.calls")).toEqual(["prune", "return"])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
