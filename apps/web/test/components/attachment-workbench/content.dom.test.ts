import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { afterAll, beforeAll, expect, test } from "bun:test"
import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"

let browser: Browser, page: Page, server: ViteDevServer, cache: string, url: string
const requested: string[] = []
beforeAll(async () => {
  cache = await mkdtemp(path.join(tmpdir(), "attachment-content-test-"))
  const root = path.resolve(import.meta.dir, "../../fixtures/attachment-workbench")
  server = await createServer({
    cacheDir: cache,
    configFile: false,
    root,
    optimizeDeps: {
      noDiscovery: true,
      include: [
        "solid-js",
        "solid-js/web",
        "@lingui/solid",
        "@lingui/core",
        "fflate",
        "dompurify",
        "pdfjs-dist",
        "pdfjs-dist/web/pdf_viewer.mjs",
        "marked",
        "@ericsanchezok/synergy-ui > marked-katex-extension",
        "marked-shiki",
        "@pierre/diffs",
        "@pierre/diffs/ssr",
        "shiki",
        "zod",
        "katex",
        "@ericsanchezok/synergy-ui > streaming-markdown",
      ],
    },
    plugins: [
      solidPlugin(),
      {
        name: "attachment-content-fixture",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url?.startsWith("/session/")) {
              requested.push(req.url)
              res.setHeader("Content-Type", "application/json")
              res.end(
                JSON.stringify({
                  parts: [
                    {
                      id: "attachment-original",
                      sessionID: "session-original",
                      messageID: "message-original",
                      type: "attachment",
                      mime: "image/svg+xml",
                      filename: "history.svg",
                      url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
                    },
                  ],
                }),
              )
              return
            }
            if (req.url?.split("?")[0] !== "/") return next()
            res.setHeader("Content-Type", "text/html")
            res.end('<div id="root"></div><script type="module" src="/content.tsx"></script>')
          })
        },
      },
    ],
    resolve: {
      alias: Object.fromEntries([
        ...["file", "sdk", "platform", "workbench"].map((name) => [
          `@/context/${name}`,
          path.join(root, "contexts.ts"),
        ]),
        ["@", path.resolve(import.meta.dir, "../../../src")],
      ]),
    },
    server: {
      host: "127.0.0.1",
      port: await fixturePort(),
      fs: { allow: [path.resolve(import.meta.dir, "../../../../..")] },
    },
  })
  await server.listen()
  url = server.resolvedUrls!.local[0]!
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
}, 30_000)
afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (cache) await rm(cache, { recursive: true, force: true })
})

test("an uploaded attachment reads without a File provider and keeps its original download", async () => {
  await page.goto(url)
  await page.locator(".attachment-workbench,[role=alert]").waitFor({ timeout: 10000 })
  expect(await page.locator("[role=alert]").allTextContents()).toEqual([])
  await page.getByRole("link", { name: "Download", exact: true }).waitFor({ timeout: 5000 })
  expect(await page.locator("[role=alert]").count()).toBe(0)
  expect(await page.getByRole("img", { name: "original.svg" }).isVisible()).toBe(true)
  expect(await page.getByRole("link", { name: "Download", exact: true }).getAttribute("download")).toBe("original.svg")
  expect(await page.getByRole("button", { name: "View source in Files" }).count()).toBe(0)
})
test("source navigation uses an optional host binding", async () => {
  await page.goto(`${url}?source`)
  await page.locator(".attachment-workbench,[role=alert]").waitFor({ timeout: 10000 })
  expect(await page.locator("[role=alert]").allTextContents()).toEqual([])
  await page.getByRole("button", { name: "View source in Files" }).click({ timeout: 5000 })
  expect(await page.getByLabel("Opened source").textContent()).toBe("docs/original.svg")
})
test("an evicted message is read using its original session and message identity", async () => {
  await page.goto(`${url}?remote`)
  await page.locator(".attachment-workbench,[role=alert]").waitFor({ timeout: 10000 })
  expect(await page.locator("[role=alert]").allTextContents()).toEqual([])
  await page.getByRole("link", { name: "Download", exact: true }).waitFor({ timeout: 5000 })
  expect(await page.getByRole("img", { name: "history.svg" }).isVisible()).toBe(true)
  expect(requested.at(-1)).toBe("/session/session-original/message/message-original")
})

test("an evicted message read failure stays local and can be retried", async () => {
  let failed = true
  await page.route("**/session/session-original/message/message-original", async (route) => {
    if (failed) {
      failed = false
      await route.fulfill({ status: 503, body: "Unavailable" })
    } else await route.continue()
  })
  await page.goto(`${url}?remote`)
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await page.getByRole("img", { name: "history.svg" }).waitFor()
  expect(await page.locator("[role=alert]").count()).toBe(0)
  await page.unroute("**/session/session-original/message/message-original")
})
