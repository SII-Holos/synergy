import { afterAll, beforeAll, expect, test } from "bun:test"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"

let browser: Browser
let page: Page
let server: ViteDevServer

beforeAll(async () => {
  const root = path.resolve(import.meta.dir, "../../fixtures/plugin-ui5")
  server = await createServer({
    configFile: false,
    root,
    plugins: [
      solidPlugin(),
      {
        name: "prompt-fixture",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.includes("/session/")) return next()
            res.setHeader("Content-Type", "text/html")
            res.end('<div id="root"></div><script type="module" src="/prompt.tsx"></script>')
          })
        },
      },
    ],
    resolve: { alias: { "@": path.resolve(import.meta.dir, "../../../src") } },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [path.resolve(import.meta.dir, "../../../../..")] } },
  })
  await server.listen()
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  await page.goto(`${server.resolvedUrls!.local[0]}c2NvcGU/session/a`)
  await page.waitForSelector("#seed")
}, 30000)

afterAll(async () => {
  await page?.close()
  await browser?.close()
  await server?.close()
})

test("late restoration writes the captured draft, never the newly navigated session", async () => {
  await page.click("#seed")
  await page.click("#capture")
  await page.click("#b")
  await page.click("#restore")
  expect(await page.locator("#session").textContent()).toBe("b")
  expect(await page.locator("#value").textContent()).toBe("")
  await page.click("#a")
  expect(await page.locator("#value").textContent()).toBe("restored A")
})

test("late submit failure restores an untouched draft and preserves subsequent user edits", async () => {
  await page.click("#submit")
  await page.click("#fail-submit")
  expect(await page.locator("#value").textContent()).toBe("submitted")
  await page.click("#submit")
  await page.click("#b")
  await page.click("#seed")
  await page.click("#a")
  await page.click("#seed")
  await page.click("#fail-submit")
  expect(await page.locator("#value").textContent()).toBe("hello")
  await page.click("#b")
  expect(await page.locator("#value").textContent()).toBe("hello")
  await page.click("#a")
})

test("headless edits survive native editor replacement and native range selection uses the same document", async () => {
  await page.click("#seed")
  await page.click("#edit")
  expect(await page.locator("#value").textContent()).toBe("h你好o")
  await page.click("#mount")
  expect(await page.locator("#editor").textContent()).toBe("h你好o")
  await page.click("#seed")
  await page.click("#select")
  expect(await page.evaluate(() => getSelection()?.toString())).toBe("ell")
  await page.click("#edit")
  expect(await page.locator("#editor").textContent()).toBe("h你好o")
  await page.click("#mount")
  await page.click("#seed")
  await page.click("#edit")
  expect(await page.locator("#value").textContent()).toBe("h你好o")
})

test("plain-text paste replaces the selection and participates in native undo and redo", async () => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
  for (const text of [
    "第一行\nSecond line",
    '<img src="missing" onerror="alert(1)"> & <script>throw 1</script>',
    "第一行\r\n\r\nLast line\n",
    "  if (ready) {\n    work()  \n  }\n",
    "中文 English 123，长文本粘贴验收。".repeat(500),
  ]) {
    await page.reload()
    await page.click("#seed")
    await page.click("#mount")
    await page.click("#select")
    await page.evaluate((text) => navigator.clipboard.writeText(text), text)
    await page.locator("#editor").press("ControlOrMeta+v")
    const expected = `h${text.replace(/\r\n?/g, "\n")}o`
    expect(await page.locator("#value").textContent()).toBe(expected)
    expect(await page.locator("#editor img, #editor script").count()).toBe(0)
    await page.locator("#editor").press("ControlOrMeta+z")
    expect(await page.locator("#value").textContent()).toBe("hello")
    await page.locator("#editor").press("ControlOrMeta+Shift+z")
    expect(await page.locator("#value").textContent()).toBe(expected)
    await page.locator("#editor").press("ControlOrMeta+a")
    await page.locator("#editor").press("Backspace")
    expect(await page.locator("#value").textContent()).toBe("")
    await page.locator("#editor").press("ControlOrMeta+z")
    expect(await page.locator("#value").textContent()).toBe(expected)
  }
}, 20_000)
