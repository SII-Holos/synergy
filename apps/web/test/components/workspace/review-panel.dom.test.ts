import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { build, preview, type InlineConfig, type PreviewServer } from "vite"
import solid from "vite-plugin-solid"
import tailwind from "@tailwindcss/vite"
import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import type { FileDiff, ReviewStateValue } from "@ericsanchezok/synergy-sdk/client"

const appSrc = path.resolve(import.meta.dir, "../../../src")
const repo = path.resolve(appSrc, "../../..")
const workspace = { id: "wsp_review", generation: 1, root: "/review" }
const files = ["src/first.ts", "src/nested/second.ts", "docs/notes.md"]
const patch = (file: string) =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,2 +1,2 @@\n context\n-before\n+after\n`
const rows = (): FileDiff[] =>
  files.map((file) => ({ file, workspace, additions: 1, deletions: 1, patch: patch(file) }))
let state: ReviewStateValue = { version: 1, viewed: {}, comments: [] }
let comparisonRows = rows()
let failing = false
let release: (() => void) | undefined
let hold = false
let reads = 0
let compared: { from?: string; to?: string } = {}
let fixture: string
let server: PreviewServer
let browser: Browser
let page: Page
let base: string
const errors: string[] = []
const boot: string[] = []

beforeAll(async () => {
  fixture = await mkdtemp(path.join(import.meta.dir, ".review-panel-"))
  await Bun.write(
    path.join(fixture, "index.html"),
    '<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
  )
  await Bun.write(
    path.join(fixture, "contexts.ts"),
    `import {createSignal} from "solid-js"
    import {createSynergyClient} from "@ericsanchezok/synergy-sdk/client"
    const [id,setId]=createSignal("first")
    const client=createSynergyClient({baseUrl:location.origin})
    export const switchSession=()=>setId("second")
    export const useParams=()=>({get id(){return id()}})
    export const useSDK=()=>({url:location.origin,scopeKey:"scope",client,event:{on:()=>()=>{}}})
    export const useFile=()=>({workspace:{...${JSON.stringify(workspace)},path:"/review"},openWorkspaceFile:()=>{}})
    export const useSync=()=>({session:{get:()=>undefined}})
    export const useSessionDataView=()=>()=>({messagesFor:()=>[]})
    export const useFileRestore=()=>()=>{}
  `,
  )
  await Bun.write(
    path.join(fixture, "main.tsx"),
    `import {render} from "solid-js/web"
    import {ErrorBoundary,Suspense} from "solid-js"
    import {I18nProvider} from "@lingui/solid"
    import {setupI18n} from "@lingui/core"
    import {ThemeProvider,useTheme} from "@ericsanchezok/synergy-ui/theme"
    import {DialogProvider} from "@ericsanchezok/synergy-ui/context/dialog"
    import {ensureSynergyHighlightTheme} from "@ericsanchezok/synergy-ui/context/marked"
    import {ReviewPanel} from ${JSON.stringify(`/@fs/${appSrc}/components/workspace/review-panel.tsx`)}
    import ${JSON.stringify(`/@fs/${appSrc}/index.css`)}
    import {switchSession} from "./contexts"
    const i18n=setupI18n({locale:"en",messages:{en:{}}})
    function App(){
      const theme=useTheme()
      window.fixture={switchSession,theme:theme.setColorScheme}
      return <ErrorBoundary fallback={error=><p data-testid="fatal">{String(error)}</p>}>
        <Suspense fallback={<p data-testid="suspended">Suspended</p>}>
          <ReviewPanel tab={{id:"review",kind:"review",title:"Review"}}/>
        </Suspense>
      </ErrorBoundary>
    }
    ensureSynergyHighlightTheme().then(()=>render(()=><I18nProvider i18n={i18n}><ThemeProvider><DialogProvider><App/></DialogProvider></ThemeProvider></I18nProvider>,document.getElementById("root")))
    document.head.insertAdjacentHTML("beforeend","<style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}</style>")
  `,
  )
  const config: InlineConfig = {
    configFile: false,
    root: fixture,
    publicDir: false,
    logLevel: "error",
    mode: "test",
    define: { "process.env.NODE_ENV": JSON.stringify("test") },
    cacheDir: path.join(fixture, ".vite"),
    plugins: [
      { name: "fixture-files", resolveId: (id) => (id.startsWith("/@fs/") ? id.slice(4) : undefined) },
      solid(),
      tailwind(),
      {
        name: "review-api-fixture",
        configurePreviewServer(vite) {
          vite.middlewares.use(async (request, response, next) => {
            const url = new URL(request.url!, "http://fixture")
            if (!url.pathname.startsWith("/session/") && !url.pathname.startsWith("/review/")) return next()
            let value: unknown
            if (url.pathname.endsWith("/diff") && !url.pathname.includes("/files/")) {
              const captured = url.pathname.includes("/second/") ? [] : comparisonRows
              if (hold)
                await new Promise<void>((resolve) => {
                  release = resolve
                })
              if (failing) {
                response
                  .writeHead(503, { "content-type": "application/json" })
                  .end(JSON.stringify({ data: { message: "comparison unavailable" } }))
                return
              }
              value = captured
            } else if (url.pathname.includes("/review/state/")) {
              if (request.method === "PUT") {
                const body: Buffer[] = []
                for await (const chunk of request) body.push(chunk)
                state = JSON.parse(Buffer.concat(body).toString()).state
              }
              value = { revision: 1, state }
            } else if (url.pathname.endsWith("/files/versions")) {
              reads++
              const before =
                url.searchParams.get("file") === "huge.ts"
                  ? Array.from({ length: 20_000 }, (_, index) => `export const row${index} = ${index}\n`).join("")
                  : "context\nbefore\n"
              const after =
                url.searchParams.get("file") === "huge.ts"
                  ? before.replace("row5 = 5", "row5 = 500")
                  : "context\nafter\n"
              value = {
                before: { kind: "text", version: "before", bytes: before.length, content: before },
                after: { kind: "text", version: "after", bytes: after.length, content: after },
              }
            } else if (url.pathname.endsWith("/files/diff")) {
              value = comparisonRows.find((row) => row.file === url.searchParams.get("file"))
            } else if (url.pathname === "/review/compare") {
              compared = {
                from: url.searchParams.get("from") ?? undefined,
                to: url.searchParams.get("to") ?? undefined,
              }
              value = {
                source: "branch",
                from: "base-hash",
                to: "target-hash",
                files: comparisonRows.map((row) => ({ ...row, version: "git-version", status: "modified" })),
              }
            } else if (url.pathname === "/review/file") {
              value = {
                before: { kind: "text", version: "before", bytes: 15, content: "context\nbefore\n" },
                after: { kind: "text", version: "after", bytes: 14, content: "context\nafter\n" },
                diff: comparisonRows.find((row) => row.file === url.searchParams.get("file")),
                version: "git-version",
              }
            }
            response.writeHead(value === undefined ? 404 : 200, { "content-type": "application/json" })
            response.end(JSON.stringify(value ?? {}))
          })
        },
      },
    ],
    resolve: {
      conditions: ["module", "browser", "development"],
      alias: [
        ...[
          "@solidjs/router",
          "@/context/sdk",
          "@/context/file",
          "@/context/sync",
          "@/context/session-data-view",
          "@/components/session/file-restore-dialog-loader",
        ].map((find) => ({ find, replacement: path.join(fixture, "contexts.ts") })),
        { find: "@", replacement: appSrc },
        { find: "lru_map", replacement: Bun.resolveSync("lru_map", path.join(repo, "packages/ui")) },
        { find: "lucide-solid", replacement: Bun.resolveSync("lucide-solid", path.join(repo, "packages/ui")) },
      ],
    },
    worker: { format: "es" },
    build: { target: "esnext", outDir: path.join(fixture, "dist") },
    preview: { host: "127.0.0.1", port: await fixturePort(), strictPort: true },
  }
  await build(config)
  server = await preview(config)
  base = server.resolvedUrls!.local[0]!
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1100, height: 850 } })
  page.setDefaultTimeout(5000)
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => boot.push(message.text().slice(0, 200)))
  page.on("requestfailed", (request) => boot.push(`${request.url()} ${request.failure()?.errorText}`))
  page.on("response", (response) => {
    if (response.status() >= 400) boot.push(`${response.status()} ${response.url()}`)
  })
}, 60_000)

afterAll(async () => {
  release?.()
  await browser?.close()
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.httpServer.close((error) => (error ? reject(error) : resolve())),
    )
  if (fixture) await rm(fixture, { recursive: true, force: true })
})

async function mount(input = rows()) {
  comparisonRows = input
  state = { version: 1, viewed: {}, comments: [] }
  failing = false
  hold = false
  reads = 0
  errors.length = 0
  await page.goto(base)
  await page
    .locator(".review-file-toggle")
    .first()
    .waitFor()
    .catch(async (cause) => {
      throw new Error(
        JSON.stringify({ errors, boot: boot.slice(-15), html: await page.locator("#root").innerHTML() }),
        { cause },
      )
    })
  await page.getByRole("button", { name: "Select line 2 in after", exact: true }).first().waitFor()
}

test("jump search locates a file without filtering the diff or evicting loaded content", async () => {
  await mount()
  const content = page.locator('[data-component="review-viewer"]')
  await content.evaluate((element) => element.setAttribute("data-retained", "yes"))
  const readCount = reads
  await page.getByRole("button", { name: "Jump to file", exact: true }).click()
  await page.getByRole("combobox", { name: "Jump to file", exact: true }).fill("second")
  expect(await page.locator(".review-file-toggle").count()).toBe(3)
  await page.keyboard.press("Enter")
  await page.getByRole("button", { name: "Jump to file", exact: true }).waitFor()
  expect(await content.getAttribute("data-retained")).toBe("yes")
  expect(await page.locator(".review-file-toggle").count()).toBe(3)
  expect(reads).toBe(readCount)
  expect(errors).toEqual([])
}, 30_000)

test("directory filtering keeps the diff, selected lines and cached file content", async () => {
  await page.setViewportSize({ width: 1100, height: 850 })
  await mount()
  const sidebar = page.getByRole("complementary", { name: "Files", exact: true })
  const content = page.locator(".review-content")
  const bounds = await sidebar.boundingBox()
  const diffBounds = await content.boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(diffBounds!.x + diffBounds!.width)
  await page.getByRole("button", { name: "Select line 2 in after", exact: true }).first().click()
  await page.getByRole("textbox", { name: "Comment", exact: true }).fill("keep this draft")
  const readCount = reads
  await sidebar.getByRole("textbox", { name: "Filter files…", exact: true }).fill("no-match")
  expect(await sidebar.getByRole("tree").count()).toBe(0)
  expect(await page.locator(".review-file-toggle").count()).toBe(3)
  expect(await page.getByRole("textbox", { name: "Comment", exact: true }).inputValue()).toBe("keep this draft")
  expect(await page.locator(".review-comments").textContent()).toContain("src/first.ts · 2–2")
  expect(reads).toBe(readCount)
  expect(errors).toEqual([])
})

test("reading controls expose their states and keyboard jump returns focus", async () => {
  await page.setViewportSize({ width: 700, height: 850 })
  await mount()
  const tools = page.getByRole("group", { name: "Review options", exact: true })
  expect(await tools.getByRole("button").count()).toBe(7)
  expect(
    await tools
      .getByRole("button")
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))),
  ).toEqual([
    "Review options",
    "Jump to file",
    "Refresh comparison",
    "Wrap lines",
    "Collapse all",
    "Diff layout: Auto",
    "Show files",
  ])
  const wrap = tools.getByRole("button", { name: "Wrap lines", exact: true })
  await wrap.evaluate((element) => element.setAttribute("data-retained", "yes"))
  expect(await wrap.getAttribute("aria-pressed")).toBe("true")
  await wrap.click()
  expect(await wrap.getAttribute("aria-pressed")).toBe("false")
  expect(await wrap.getAttribute("data-retained")).toBe("yes")
  expect(await wrap.evaluate((element) => document.activeElement === element)).toBe(true)
  await page.locator('[data-overflow="scroll"]').first().waitFor()
  await wrap.click()
  await page.getByRole("button", { name: "Jump to file", exact: true }).click()
  const input = page.getByRole("combobox", { name: "Jump to file", exact: true })
  await input.waitFor()
  await input.press("ArrowDown")
  await input.press("Enter")
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Jump to file")
  expect(
    await page.locator('.review-file-header[data-selected="true"] .review-file-toggle').getAttribute("aria-label"),
  ).toBe("src/nested/second.ts")
  await page.getByRole("button", { name: "Jump to file", exact: true }).click()
  await input.fill("not-found")
  await page.getByRole("status").getByText("No files match this filter.", { exact: true }).waitFor()
  await input.press("Escape")
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Jump to file")
  expect(await page.locator(".review-file-toggle").count()).toBe(3)
  const fold = page.getByRole("button", { name: "Collapse all", exact: true })
  await fold.evaluate((element) => element.setAttribute("data-retained", "yes"))
  await fold.press("Space")
  expect(await page.locator('.review-file-toggle[aria-expanded="true"]').count()).toBe(0)
  const expand = page.getByRole("button", { name: "Expand all", exact: true })
  expect(await expand.getAttribute("data-retained")).toBe("yes")
  expect(await expand.evaluate((element) => document.activeElement === element)).toBe(true)
  await page.getByRole("button", { name: "Expand all", exact: true }).click()
  expect(await page.locator('.review-file-toggle[aria-expanded="true"]').count()).toBe(3)
  for (const [label, type] of [
    ["Split", "split"],
    ["Unified", "single"],
    ["Auto", "split"],
  ]) {
    await tools.getByRole("button", { name: /^Diff layout:/ }).click()
    const option = page.getByRole("option", { name: label, exact: true })
    await option.click()
    await page.locator(`[data-diff-type="${type}"]`).first().waitFor()
    expect(await tools.getByRole("button", { name: `Diff layout: ${label}`, exact: true }).count()).toBe(1)
  }
  expect(errors).toEqual([])
})

test("refresh holds loaded contents through pending and failure, then retry recovers", async () => {
  await mount(rows().map(({ patch: _patch, ...row }) => row))
  const after = page.locator(".review-content").getByText("after", { exact: true }).first()
  await after.waitFor()
  const header = page.locator(".review-file-header").first()
  await header.evaluate((element) => element.setAttribute("data-retained", "yes"))
  const readCount = reads
  hold = true
  await page.getByRole("button", { name: "Refresh comparison", exact: true }).click()
  await page.getByRole("status").getByText("Refreshing…", { exact: true }).waitFor()
  expect(await after.isVisible()).toBe(true)
  expect(await header.getAttribute("data-retained")).toBe("yes")
  expect(reads).toBe(readCount)
  expect(await page.getByTestId("suspended").count()).toBe(0)
  failing = true
  hold = false
  release?.()
  await page.getByRole("alert").waitFor()
  expect(await after.isVisible()).toBe(true)
  failing = false
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('[role="alert"]'))
  await after.waitFor()
  expect(errors).toEqual([])
})

test("wide and narrow file controls have a visible effect without replacing the viewer", async () => {
  await page.setViewportSize({ width: 1100, height: 850 })
  await mount()
  const viewer = page.locator('[data-component="review-viewer"]')
  await viewer.evaluate((element) => element.setAttribute("data-retained", "yes"))
  await page.getByRole("button", { name: "Hide files", exact: true }).click()
  expect(await page.locator(".review-sidebar").count()).toBe(0)
  expect(await page.getByRole("button", { name: "Show files", exact: true }).getAttribute("aria-pressed")).toBe("false")
  await page.getByRole("button", { name: "Show files", exact: true }).click()
  expect(await page.locator(".review-sidebar").count()).toBe(1)
  for (const width of [375, 320, 700, 1100]) {
    await page.setViewportSize({ width, height: 850 })
    if (width < 800) {
      await page.getByRole("button", { name: "Show files", exact: true }).click()
      await page.getByRole("tree", { name: "Files", exact: true }).waitFor()
      await page.getByRole("textbox", { name: "Filter files…", exact: true }).press("Escape")
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Show files")
    }
    const geometry = await page.locator(".review-toolbar-tools button").evaluateAll((buttons) =>
      buttons.map((button) => {
        const { x, y, width, height } = button.getBoundingClientRect()
        const svg = button.querySelector("svg")?.getBoundingClientRect()
        return { x, y, width, height, icon: svg?.width, label: button.getAttribute("aria-label") }
      }),
    )
    expect(geometry).toEqual(geometry.map((item) => ({ ...item, width: 32, height: 32, icon: 16 })))
    expect(geometry.every((item) => item.x >= 0 && item.x + item.width <= width)).toBe(true)
    expect(new Set(geometry.map((item) => item.y)).size).toBe(1)
    expect(await viewer.getAttribute("data-retained")).toBe("yes")
  }
  expect(errors).toEqual([])
})

test("same-name files retain workspace labels and independent directory navigation", async () => {
  await page.setViewportSize({ width: 1100, height: 850 })
  await mount([...rows(), { ...rows()[0]!, workspace: { id: "wsp_other", generation: 2, root: "/other" } }])
  await page.getByRole("button", { name: "Jump to file", exact: true }).click()
  await page.getByRole("combobox", { name: "Jump to file", exact: true }).fill("first")
  const options = page.getByRole("option")
  await options.nth(1).waitFor()
  expect(await options.count()).toBe(2)
  expect(await options.nth(0).textContent()).toContain("/review")
  expect(await options.nth(1).textContent()).toContain("/other")
  await options.nth(1).click()
  const tree = page.getByRole("tree", { name: "Files", exact: true })
  const leaves = tree.getByRole("treeitem", { name: /first.ts/ })
  expect(await leaves.count()).toBe(2)
  expect(await leaves.nth(1).isVisible()).toBe(true)
  expect(await tree.locator('button[tabindex="0"]').count()).toBe(1)
  expect(errors).toEqual([])
})

test("late comparison responses cannot repopulate another session's empty review", async () => {
  await mount()
  hold = true
  await page.getByRole("button", { name: "Refresh comparison", exact: true }).click()
  await page.getByRole("status").getByText("Refreshing…", { exact: true }).waitFor()
  hold = false
  await page.evaluate(() => (window as unknown as { fixture: { switchSession(): void } }).fixture.switchSession())
  await page.getByRole("status").getByText("No changes", { exact: true }).waitFor()
  release?.()
  expect(await page.locator(".review-file-toggle").count()).toBe(0)
  expect(await page.getByRole("button", { name: "Jump to file", exact: true }).isEnabled()).toBe(false)
  expect(errors).toEqual([])
})

test("initial loading and failure keep reading controls available for an explicit retry", async () => {
  comparisonRows = rows()
  hold = true
  failing = false
  errors.length = 0
  await page.goto(base)
  await page.getByRole("status").getByText("Loading comparison…", { exact: true }).waitFor()
  expect(await page.getByRole("button", { name: "Wrap lines", exact: true }).isEnabled()).toBe(true)
  expect(await page.getByRole("button", { name: "Jump to file", exact: true }).isEnabled()).toBe(false)
  failing = true
  hold = false
  release?.()
  await page.getByRole("alert").waitFor()
  expect(await page.getByTestId("suspended").count()).toBe(0)
  failing = false
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await page.locator(".review-file-toggle").first().waitFor()
  expect(await page.getByRole("button", { name: "Jump to file", exact: true }).isEnabled()).toBe(true)
  expect(errors).toEqual([])
})

test("comparison references edit through one compact control and retain API parameters", async () => {
  await page.setViewportSize({ width: 700, height: 850 })
  await mount()
  await page.getByRole("button", { name: "Comparison: Session", exact: true }).click()
  await page.getByRole("option", { name: "Branch", exact: true }).click()
  const refs = page.getByRole("button", { name: "Comparison: origin/dev → HEAD", exact: true })
  await refs.waitFor()
  expect(compared).toEqual({ from: "origin/dev", to: "HEAD" })
  expect(await page.getByRole("textbox", { name: "Base reference", exact: true }).count()).toBe(0)
  await refs.click()
  await page.getByRole("textbox", { name: "Base reference", exact: true }).fill("  ")
  expect(await page.getByRole("button", { name: "Compare", exact: true }).isEnabled()).toBe(false)
  await page.getByRole("textbox", { name: "Base reference", exact: true }).fill(" origin/main ")
  await page.getByRole("textbox", { name: "Target reference", exact: true }).fill(" feature ")
  await page.getByRole("button", { name: "Compare", exact: true }).click()
  await page.getByRole("button", { name: "Comparison: origin/main → feature", exact: true }).waitFor()
  expect(compared).toEqual({ from: "origin/main", to: "feature" })
  expect(errors).toEqual([])
}, 30_000)

test("directory keyboard navigation retains collapsed folders across local matching", async () => {
  await page.setViewportSize({ width: 1100, height: 850 })
  await mount()
  const tree = page.getByRole("tree", { name: "Files", exact: true })
  const src = tree.getByRole("treeitem", { name: "src", exact: true })
  await src.press("ArrowLeft")
  expect(await src.getAttribute("aria-expanded")).toBe("false")
  const filter = page.getByRole("textbox", { name: "Filter files…", exact: true })
  await filter.fill("second")
  await tree.getByRole("treeitem", { name: /second.ts/ }).waitFor()
  await filter.fill("")
  expect(await src.getAttribute("aria-expanded")).toBe("false")
  await src.press("ArrowRight")
  await src.press("ArrowRight")
  await page.waitForFunction(() => document.activeElement?.getAttribute("title") === "src/first.ts")
  await page.keyboard.press("ArrowDown")
  await page.waitForFunction(() => document.activeElement?.getAttribute("title") === "src/nested")
  await page.keyboard.press("ArrowRight")
  await page.waitForFunction(() => document.activeElement?.getAttribute("title") === "src/nested/second.ts")
  await page.keyboard.press("Enter")
  expect(
    await page.locator('.review-file-header[data-selected="true"] .review-file-toggle').getAttribute("aria-label"),
  ).toBe("src/nested/second.ts")
  expect(await tree.locator('button[tabindex="0"]').count()).toBe(1)
  expect(errors).toEqual([])
}, 30_000)

test("global commands dismiss their menu while advanced toggles remain available", async () => {
  await mount()
  const options = page.getByRole("button", { name: "Review options", exact: true })
  await options.click()
  await page.getByRole("checkbox", { name: "Word differences", exact: true }).press("Space")
  expect(await page.getByRole("checkbox", { name: "Show full file", exact: true }).isVisible()).toBe(true)
  await page.getByRole("button", { name: "Next file", exact: true }).click()
  expect(await options.getAttribute("aria-expanded")).toBe("false")
  await options.click()
  await page.getByRole("button", { name: "Review comments", exact: true }).click()
  await page.getByRole("complementary", { name: "Review comments", exact: true }).waitFor()
  expect(await options.getAttribute("aria-expanded")).toBe("false")
  expect(errors).toEqual([])
})

test("file headers respond to native folding, version and menu actions", async () => {
  await mount()
  const toggle = page.getByRole("button", { name: "src/first.ts", exact: true })
  const header = page.locator(".review-file-header").filter({ has: toggle })
  await toggle.click()
  expect(await toggle.getAttribute("aria-expanded")).toBe("false")
  await toggle.click()
  expect(await toggle.getAttribute("aria-expanded")).toBe("true")
  await header.getByRole("button", { name: "File versions", exact: true }).click()
  await page.getByRole("dialog", { name: "src/first.ts", exact: true }).waitFor()
  await page.keyboard.press("Escape")
  await page.getByRole("dialog", { name: "src/first.ts", exact: true }).waitFor({ state: "hidden" })
  await header.getByRole("button", { name: "File options", exact: true }).click()
  await page.getByRole("button", { name: "Copy path", exact: true }).waitFor()
  await page.keyboard.press("Escape")
  await header.locator('[data-slot="checkbox-checkbox-control"]').click()
  await header.locator('[data-component="checkbox"][data-checked]').waitFor()
  expect(await header.getByRole("checkbox", { name: "Mark as viewed", exact: true }).isChecked()).toBe(true)
  expect(errors).toEqual([])
}, 30_000)

test("compact touch controls fit phone panes and keep refresh and fold reachable", async () => {
  const desktop = page
  page = await browser.newPage({ viewport: { width: 320, height: 850 }, hasTouch: true })
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await mount()
    for (const width of [320, 375]) {
      await page.setViewportSize({ width, height: 850 })
      const tools = page.getByRole("group", { name: "Review options", exact: true })
      const buttons = tools.getByRole("button")
      expect(await buttons.count()).toBe(5)
      const boxes = await buttons.evaluateAll((elements) =>
        elements.map((element) => {
          const { x, width, height } = element.getBoundingClientRect()
          return { x, width, height }
        }),
      )
      expect(boxes.every((box) => box.width >= 44 && box.height >= 44 && box.x + box.width <= width)).toBe(true)
      await tools.getByRole("button", { name: "Review options", exact: true }).tap()
      const menu = page.locator('[data-component="popover-content"]')
      await menu.getByRole("button", { name: "Refresh comparison", exact: true }).waitFor()
      expect(await menu.getByRole("button", { name: "Collapse all", exact: true }).isVisible()).toBe(true)
      const full = menu.getByRole("checkbox", { name: "Show full file", exact: true })
      const checked = await full.isChecked()
      const label = menu.getByText("Show full file", { exact: true })
      await label.tap({ position: { x: 3, y: 40 } })
      const labelBox = await label.boundingBox()
      expect(labelBox && labelBox.height >= 44).toBe(true)
      expect(await full.isChecked()).toBe(!checked)
      await page.keyboard.press("Escape")
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Review options")
      const header = page
        .locator(".review-file-header")
        .filter({ has: page.getByRole("button", { name: "src/first.ts", exact: true }) })
      const viewed = header.locator('[data-component="checkbox"]')
      const disclosure = await header.getByRole("button", { name: "src/first.ts", exact: true }).boundingBox()
      expect(disclosure && disclosure.height >= 44).toBe(true)
      const target = await viewed.boundingBox()
      expect(target && target.width >= 44 && target.height >= 44).toBe(true)
      await viewed.tap({ position: { x: 3, y: 22 } })
      await header.locator('[data-component="checkbox"][data-checked]').waitFor()
      expect(await header.getByRole("checkbox", { name: "Mark as viewed", exact: true }).isChecked()).toBe(true)
      await header.getByRole("checkbox", { name: "Mark as viewed", exact: true }).press("Space")
      await header.locator('[data-component="checkbox"]:not([data-checked])').waitFor()
    }
    expect(errors).toEqual([])
  } finally {
    await page.close()
    page = desktop
  }
})

test("same-mount reading changes preserve the scroll anchor and line/comment selection", async () => {
  const inspector = await page.context().newCDPSession(page)
  try {
    await page.setViewportSize({ width: 1100, height: 850 })
    const large = { file: "huge.ts", workspace, additions: 1, deletions: 1 }
    await mount([large, ...rows()])
    await inspector.send("Emulation.setCPUThrottlingRate", { rate: 4 })
    await page.getByRole("button", { name: "Review options", exact: true }).click()
    await page.getByRole("checkbox", { name: "Show full file", exact: true }).press("Space")
    expect(await page.getByRole("checkbox", { name: "Show full file", exact: true }).isChecked()).toBe(true)
    await page.keyboard.press("Escape")
    const viewer = page.locator('[data-component="review-viewer"]')
    await page.waitForFunction(
      () => document.querySelector<HTMLElement>('[data-component="review-viewer"]')!.scrollHeight > 100_000,
    )
    await viewer.evaluate((element) => {
      element.scrollTop = 12_000
    })
    const line = viewer.getByRole("button", { name: /Select line [1-9]\d{2,} in after/ }).first()
    await line.waitFor()
    const name = await line.getAttribute("aria-label")
    await line.click()
    await page.getByRole("textbox", { name: "Comment", exact: true }).fill("retained comment")
    const firstLine = viewer.getByRole("button", { name: name!, exact: true })
    const before = await firstLine.boundingBox()
    for (const action of ["files", "wrap", "layout"] as const) {
      if (action === "files") await page.getByRole("button", { name: "Hide files", exact: true }).click()
      else if (action === "wrap") await page.getByRole("button", { name: "Wrap lines", exact: true }).click()
      else {
        await page.getByRole("button", { name: /^Diff layout:/ }).click()
        await page.getByRole("option", { name: "Unified", exact: true }).click()
      }
      await firstLine.waitFor()
      const after = await firstLine.boundingBox()
      expect(Math.abs(after!.y - before!.y)).toBeLessThan(30)
      expect(await page.getByRole("textbox", { name: "Comment", exact: true }).inputValue()).toBe("retained comment")
    }
    const lineCount = await viewer.locator("[data-line]").count()
    expect(lineCount).toBeGreaterThan(0)
    expect(lineCount).toBeLessThan(200)
    expect(await viewer.locator("[data-error-wrapper]").count()).toBe(0)
    expect(errors).toEqual([])
  } finally {
    await inspector.send("Emulation.setCPUThrottlingRate", { rate: 1 })
    await inspector.detach()
  }
}, 30_000)

test("large file collections bound jump options and navigate to a distant file", async () => {
  await page.setViewportSize({ width: 700, height: 850 })
  await mount(
    Array.from({ length: 5000 }, (_, index) => ({
      file: `src/long-directory/file-${index}.ts`,
      workspace,
      additions: 1,
      deletions: 1,
      patch: patch(`src/long-directory/file-${index}.ts`),
    })),
  )
  await page.getByRole("button", { name: "Jump to file", exact: true }).click()
  const input = page.getByRole("combobox", { name: "Jump to file", exact: true })
  await page.getByRole("option").first().waitFor()
  expect(await page.getByRole("option").count()).toBeLessThan(30)
  await input.press("End")
  await page.getByRole("option", { name: /file-4999/ }).waitFor()
  await input.press("Enter")
  await page.getByRole("button", { name: "src/long-directory/file-4999.ts", exact: true }).waitFor()
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Jump to file")
  expect(await page.locator(".review-file-toggle").count()).toBeLessThan(60)
  await page.setViewportSize({ width: 1100, height: 850 })
  const tree = page.getByRole("tree", { name: "Files", exact: true })
  await tree.waitFor()
  expect(await tree.getByRole("treeitem").count()).toBeLessThan(80)
  await tree.getByRole("treeitem").first().press("End")
  await page.waitForFunction(() => document.activeElement?.getAttribute("title") === "src/long-directory/file-4999.ts")
  expect(errors).toEqual([])
}, 30_000)

test("theme, 200 percent scaling and reduced motion keep the reading surface reachable", async () => {
  await page.setViewportSize({ width: 1100, height: 850 })
  await mount()
  const wrap = page.getByRole("button", { name: "Wrap lines", exact: true })
  await page.emulateMedia({ reducedMotion: "reduce" })
  const colors: string[] = []
  for (const mode of ["light", "dark"] as const) {
    await page.evaluate(
      (value) => (window as unknown as { fixture: { theme(mode: string): void } }).fixture.theme(value),
      mode,
    )
    await page.waitForFunction((value) => document.documentElement.dataset.colorScheme === value, mode)
    colors.push(await wrap.evaluate((element) => getComputedStyle(element).backgroundColor))
    await wrap.hover()
    expect(await wrap.getAttribute("aria-pressed")).toBe("true")
  }
  expect(colors[0]).not.toBe(colors[1])
  await page.emulateMedia({ reducedMotion: "reduce" })
  expect(await wrap.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe("0s")
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2"
  })
  const boxes = await page
    .locator(".review-toolbar-tools button")
    .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().right))
  expect(boxes.every((right) => right <= 1100)).toBe(true)
  await wrap.click()
  expect(await wrap.getAttribute("aria-pressed")).toBe("false")
  expect(errors).toEqual([])
  await page.emulateMedia({ reducedMotion: "no-preference" })
})
