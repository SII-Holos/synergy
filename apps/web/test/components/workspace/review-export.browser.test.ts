import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { createServer, type Server } from "node:http"
import { chromium, type Browser, type Page } from "playwright"
import { build, normalizePath } from "vite"
import { formatReviewApplyCommand } from "../../../src/components/workspace/review-export"

const patch =
  "diff --git a/with space.txt b/with space.txt\nnew file mode 100644\n--- /dev/null\n+++ b/with space.txt\n@@ -0,0 +1 @@\n+中文 🙂\n"
let fixture: string
let browser: Browser
let page: Page
let server: Server
let url: string

beforeAll(async () => {
  const cache = path.resolve(import.meta.dir, "../../../node_modules/.cache")
  await mkdir(cache, { recursive: true })
  fixture = await mkdtemp(path.join(cache, "review-export-"))
  const implementation = normalizePath(
    path.resolve(import.meta.dir, "../../../src/components/workspace/review-export.ts"),
  )
  await Bun.write(
    path.join(fixture, "index.html"),
    '<button>Export patch</button><script type="module" src="/main.ts"></script>',
  )
  await Bun.write(
    path.join(fixture, "main.ts"),
    `
    import {downloadReviewPatch} from ${JSON.stringify(implementation)}
    document.querySelector("button").onclick=async()=>{
      await Promise.resolve()
      downloadReviewPatch(${JSON.stringify(patch)})
    }
  `,
  )
  const dist = path.join(fixture, "dist")
  await build({ configFile: false, root: fixture, logLevel: "error", build: { outDir: dist, target: "esnext" } })
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url!, "http://fixture").pathname
    const file = Bun.file(path.join(dist, pathname === "/" ? "index.html" : pathname.slice(1)))
    if (!(await file.exists())) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { "content-type": file.type })
    response.end(Buffer.from(await file.arrayBuffer()))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing fixture port")
  url = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
}, 60_000)

afterAll(async () => {
  await browser?.close()
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  if (fixture) await rm(fixture, { recursive: true, force: true })
})

test("patch download preserves canonical UTF-8 bytes after asynchronous preparation", async () => {
  await page.goto(url)
  const downloadPromise = page.waitForEvent("download")
  await page.getByRole("button", { name: "Export patch" }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe("review.patch")
  const saved = await download.path()
  expect(saved).not.toBeNull()
  expect(await Bun.file(saved!).text()).toBe(patch)
  expect(await page.locator("a[download]").count()).toBe(0)
}, 10_000)

test("apply command preserves canonical content and avoids colliding heredoc delimiters", () => {
  const payload = patch + "SYNERGY_REVIEW_PATCH\nSYNERGY_REVIEW_PATCH_END\n"
  expect(formatReviewApplyCommand(payload)).toBe(
    "git apply --binary - <<'SYNERGY_REVIEW_PATCH_END_END'\n" + payload + "SYNERGY_REVIEW_PATCH_END_END\n",
  )
  expect(formatReviewApplyCommand(patch.trimEnd())).toContain(patch + "SYNERGY_REVIEW_PATCH\n")
})
