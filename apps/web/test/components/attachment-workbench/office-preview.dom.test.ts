import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { afterAll, beforeAll, expect, test } from "bun:test"
import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"

let browser: Browser, page: Page, server: ViteDevServer, cache: string
beforeAll(async () => {
  cache = await mkdtemp(path.join(tmpdir(), "office-load-test-"))
  server = await createServer({
    cacheDir: cache,
    configFile: false,
    optimizeDeps: { include: ["solid-js", "solid-js/web", "@lingui/solid", "@lingui/core", "fflate"] },
    root: path.resolve(import.meta.dir, "../../fixtures/office"),
    plugins: [
      solidPlugin(),
      {
        name: "office-fixture",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== "/") return next()
            res.setHeader("Content-Type", "text/html")
            res.end('<div id="root"></div><script type="module" src="/load-failure.tsx"></script>')
          })
        },
      },
    ],
    resolve: { alias: { "@": path.resolve(import.meta.dir, "../../../src") } },
    server: {
      host: "127.0.0.1",
      port: await fixturePort(),
      fs: { allow: [path.resolve(import.meta.dir, "../../../../..")] },
    },
  })
  await server.listen()
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  await page.route("**/docx-reader.tsx", (route) => route.abort("failed"))
  await page.goto(server.resolvedUrls!.local[0]!)
  await page.getByRole("button", { name: "Original attachment actions" }).waitFor({ timeout: 10000 })
}, 30_000)
afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (cache) await rm(cache, { recursive: true, force: true })
})

test("a reader chunk failure stays local and leaves original attachment actions reachable", async () => {
  await page.getByText("Unable to preview this attachment.", { exact: true }).waitFor({ timeout: 4000 })
  expect(await page.getByRole("button", { name: "Original attachment actions" }).isVisible()).toBe(true)
})
