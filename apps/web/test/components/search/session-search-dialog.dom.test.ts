import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { lingui } from "@lingui/vite-plugin"

let browser: Browser
let page: Page
let server: ViteDevServer
let directory: string
let baseUrl: string
const errors: string[] = []
const source = path.resolve(import.meta.dir, "../../../src")

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".search-fixture-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { setupI18n } from "@lingui/core"
    import { I18nProvider } from "@lingui/solid"
    import { DialogProvider, useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
    import { SessionSearchDialog } from ${JSON.stringify(`/@fs/${source}/components/search/session-search-dialog.tsx`)}
    import { messages as en } from ${JSON.stringify(`/@fs/${source}/locales/en/messages.po`)}
    import "@ericsanchezok/synergy-ui/styles"
    import ${JSON.stringify(`/@fs/${source}/index.css`)}
    const i18n = setupI18n({ locale: "en", messages: { en } })
    window.requests = []
    function Fixture() {
      const dialog = useDialog()
      return <><button onClick={() => dialog.show(() => <SessionSearchDialog
        fetchPage={input => new Promise((resolve, reject) => window.requests.push({ input, resolve, reject }))}
        formatTime={() => "Today"} onSelect={item => { window.selected = item.id; dialog.close() }}
        onClose={() => dialog.close()} />)}>Search entry</button><button>Background action</button></>
    }
    window.reply = (index, ids, total) => window.requests[index].resolve({
      data: ids.map(id => ({ id, title: id, scope: { id: "home", type: "home", local: null }, time: { created: 1, updated: 1 } })), total
    })
    window.fail = index => window.requests[index].reject(new Error("Network failed"))
    render(() => <I18nProvider i18n={i18n}><DialogProvider><Fixture /></DialogProvider></I18nProvider>, document.querySelector("#root"))
  `,
  )
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, "vite-cache"),
    plugins: [solidPlugin(), tailwindcss(), ...lingui()],
    resolve: { alias: { "@": source } },
    optimizeDeps: { noDiscovery: true, include: ["solid-js", "solid-js/web", "@lingui/core", "@lingui/solid"] },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [path.resolve(source, "../../..")] } },
  })
  await server.listen()
  baseUrl = server.resolvedUrls!.local[0]!
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 375, height: 812 } })
  page.on("pageerror", (error) => errors.push(error.message))
}, 60000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

interface SearchWindow extends Window {
  selected: string
  requests: { input: { search: string; offset: number; signal: AbortSignal } }[]
  reply(index: number, ids: string[], total: number): void
  fail(index: number): void
}

async function openSearch() {
  errors.length = 0
  await page.goto(baseUrl)
  await page.getByRole("button", { name: "Search entry" }).click()
  await page.getByRole("dialog", { name: "Search sessions" }).waitFor()
  await page.waitForFunction(() => (window as unknown as SearchWindow).requests.length === 1)
}

test("focus stays in the search dialog and Escape restores its entry even with a query", async () => {
  await openSearch()
  const input = page.getByRole("combobox", { name: "Search sessions" })
  await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "combobox")
  await input.fill("draft")
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press(i % 2 ? "Tab" : "Shift+Tab")
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.keyboard.press("Escape")
  await page.getByRole("dialog").waitFor({ state: "detached" })
  await page.waitForFunction(() => document.activeElement?.textContent === "Search entry")
  expect(errors).toEqual([])
})

test("search failure can retry and a failed next page keeps the loaded results", async () => {
  await openSearch()
  await page.evaluate(() => (window as unknown as SearchWindow).fail(0))
  await page.getByText("Search failed. Your query has been kept.").waitFor()
  expect(await page.getByText("No sessions found", { exact: true }).count()).toBe(0)
  await page.getByRole("button", { name: "Retry search" }).click()
  await page.waitForFunction(() => (window as unknown as SearchWindow).requests.length === 2)
  await page.evaluate(() => (window as unknown as SearchWindow).reply(1, ["First result"], 2))
  await page.getByRole("option", { name: /First result/ }).waitFor()
  await page.getByRole("button", { name: "Load more" }).click()
  await page.waitForFunction(() => (window as unknown as SearchWindow).requests.length === 3)
  await page.evaluate(() => (window as unknown as SearchWindow).fail(2))
  await page.getByText("Could not load more. Loaded results are still available.").waitFor()
  expect(await page.getByRole("option").count()).toBe(1)
  await page.getByRole("button", { name: "Retry loading more" }).click()
  await page.waitForFunction(() => (window as unknown as SearchWindow).requests.length === 4)
  expect(await page.evaluate(() => (window as unknown as SearchWindow).requests[3].input.offset)).toBe(1)
  await page.evaluate(() => (window as unknown as SearchWindow).reply(3, ["Second result"], 2))
  await page.getByRole("option", { name: /Second result/ }).waitFor()
  expect(await page.getByRole("option").count()).toBe(2)
  expect(await page.getByRole("button", { name: "Load more", exact: true }).count()).toBe(0)
  expect(errors).toEqual([])
})

test("query races cannot replace current results and arrow selection opens only from the input", async () => {
  await openSearch()
  const input = page.getByRole("combobox")
  await input.fill("new")
  await page.evaluate(() => (window as unknown as SearchWindow).reply(0, ["Stale result"], 1))
  await page.waitForFunction(() => (window as unknown as SearchWindow).requests.length === 2)
  expect(await page.getByRole("option").count()).toBe(0)
  await page.evaluate(() => (window as unknown as SearchWindow).reply(1, ["Current result"], 1))
  await page.getByRole("option").waitFor()
  await input.focus()
  await page.keyboard.press("ArrowDown")
  expect(await input.getAttribute("aria-activedescendant")).toBe(await page.getByRole("option").getAttribute("id"))
  await page.keyboard.press("Enter")
  await page.getByRole("dialog").waitFor({ state: "detached" })
  expect(await page.evaluate(() => (window as unknown as SearchWindow).selected)).toBe("Current result")
  expect(errors).toEqual([])
})
