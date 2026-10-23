import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { build, preview, type InlineConfig, type PreviewServer } from "vite"
import solid from "vite-plugin-solid"
import tailwind from "@tailwindcss/vite"
import { lingui } from "@lingui/vite-plugin"
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
let holdFiles = false
const fileReleases = new Set<() => void>()
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
    import {MetaProvider} from "@solidjs/meta"
    import {Font} from "@ericsanchezok/synergy-ui/font"
    import {ThemeProvider,useTheme} from "@ericsanchezok/synergy-ui/theme"
    import {DialogProvider} from "@ericsanchezok/synergy-ui/context/dialog"
    import {ensureSynergyHighlightTheme} from "@ericsanchezok/synergy-ui/context/marked"
    import {ReviewPanel} from ${JSON.stringify(`/@fs/${appSrc}/components/workspace/review-panel.tsx`)}
    import {messages as en} from ${JSON.stringify(`/@fs/${appSrc}/locales/en/messages.po`)}
    import {messages as zh} from ${JSON.stringify(`/@fs/${appSrc}/locales/zh-CN/messages.po`)}
    import {messages as pseudo} from ${JSON.stringify(`/@fs/${appSrc}/locales/pseudo/messages.po`)}
    import "@ericsanchezok/synergy-ui/styles"
    import ${JSON.stringify(`/@fs/${appSrc}/index.css`)}
    import {switchSession} from "./contexts"
    const i18n=setupI18n({locale:"en",messages:{en,"zh-CN":zh,pseudo}})
    function App(){
      const theme=useTheme()
      window.fixture={switchSession,theme:theme.setColorScheme,locale:(value)=>i18n.activate(value)}
      return <ErrorBoundary fallback={error=><p data-testid="fatal">{String(error)}</p>}>
        <Suspense fallback={<p data-testid="suspended">Suspended</p>}>
          <ReviewPanel tab={{id:"review",kind:"review",title:"Review"}}/>
        </Suspense>
      </ErrorBoundary>
    }
    ensureSynergyHighlightTheme().then(()=>render(()=><MetaProvider><Font/><I18nProvider i18n={i18n}><ThemeProvider><DialogProvider><App/></DialogProvider></ThemeProvider></I18nProvider></MetaProvider>,document.getElementById("root")))
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
      ...lingui(),
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
              if (holdFiles)
                await new Promise<void>((resolve) => {
                  fileReleases.add(resolve)
                })
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
  for (const resolve of fileReleases) resolve()
  await browser?.close()
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.httpServer.close((error) => (error ? reject(error) : resolve())),
    )
  if (fixture) await rm(fixture, { recursive: true, force: true })
})

async function mount(input = rows(), pendingFiles = false) {
  for (const resolve of fileReleases) resolve()
  fileReleases.clear()
  holdFiles = pendingFiles
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
  await page.evaluate(() => document.fonts.ready)
  if (!pendingFiles) await page.getByRole("button", { name: "Select line 2 in after", exact: true }).first().waitFor()
}

test("loading glyphs rotate around their visible center and respect reduced motion", async () => {
  await page.setViewportSize({ width: 1100, height: 850 })
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await mount(rows(), true)
  const spinner = page.locator(".review-file-status .review-loading-icon").first()
  await spinner.waitFor()
  const centers = await spinner.evaluate((element) => {
    const animation = element.getAnimations()[0]!
    animation.pause()
    return [0, 250, 500, 750].map((time) => {
      animation.currentTime = time
      const glyph = element.querySelector("svg")!.getBoundingClientRect()
      return { x: glyph.x + glyph.width / 2, y: glyph.y + glyph.height / 2 }
    })
  })
  expect(Math.max(...centers.map(({ x }) => x)) - Math.min(...centers.map(({ x }) => x))).toBeLessThan(0.5)
  expect(Math.max(...centers.map(({ y }) => y)) - Math.min(...centers.map(({ y }) => y))).toBeLessThan(0.5)
  await page.emulateMedia({ reducedMotion: "reduce" })
  expect(await spinner.evaluate((element) => element.getAnimations().length)).toBe(0)
  await page.emulateMedia({ reducedMotion: "no-preference" })
})

test("short navigation popovers keep search fixed while the virtual list owns scrolling", async () => {
  const many = Array.from({ length: 100 }, (_, index) => ({ ...rows()[0]!, file: `file-${index}.ts` }))
  for (const height of [320, 260]) {
    await page.setViewportSize({ width: 700, height })
    await mount(many)
    for (const name of ["Show files", "Jump to file"]) {
      await page.getByRole("button", { name, exact: true }).click()
      const popup = page.locator('.review-popover[data-component="popover-content"]')
      const input = popup.locator("input")
      await input.waitFor()
      await popup.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)))
      const top = (await input.boundingBox())!.y
      const list = popup.getByRole(name === "Show files" ? "tree" : "listbox")
      if (name === "Show files") await list.getByRole("treeitem").first().focus()
      else await input.focus()
      await page.keyboard.press("End")
      await page
        .waitForFunction(() => {
          const popup = document.querySelector('.review-popover[data-component="popover-content"]')!
          const input = popup.querySelector("input")!
          const active = input.getAttribute("aria-activedescendant")
          const item = active ? document.getElementById(active) : popup.querySelector('[role="treeitem"]:focus')
          if (!item?.textContent?.includes("file-99.ts")) return false
          const list = popup.querySelector('[role="tree"], [role="listbox"]')!.getBoundingClientRect()
          const bounds = item.getBoundingClientRect()
          return bounds.top >= list.top - 1 && bounds.bottom <= list.bottom + 1
        })
        .catch(async (cause) => {
          throw new Error(
            JSON.stringify({
              name,
              height,
              geometry: await list.evaluate((element) => ({
                top: element.getBoundingClientRect().top,
                height: element.clientHeight,
                scrollHeight: element.scrollHeight,
                scrollTop: element.scrollTop,
                active: document.activeElement?.outerHTML,
                options: [...element.querySelectorAll('[aria-selected="true"]')].map((item) => ({
                  text: item.textContent,
                  top: item.getBoundingClientRect().top,
                })),
              })),
            }),
            { cause },
          )
        })
      const geometry = await popup.evaluate((element) => {
        const list = element.querySelector('[role="tree"], [role="listbox"]')!
        const input = element.querySelector("input")!
        const active = input.getAttribute("aria-activedescendant")
        const item = active ? document.getElementById(active)! : list.querySelector('[role="treeitem"]:focus')!
        const bounds = list.getBoundingClientRect()
        const target = item.getBoundingClientRect()
        return {
          outer: [
            ...element.querySelectorAll<HTMLElement>(
              '[data-slot="popover-body"], .review-navigation, .review-file-picker',
            ),
          ].map((node) => node.scrollHeight - node.clientHeight),
          bottom: element.getBoundingClientRect().bottom,
          itemTop: target.top - bounds.top,
          itemBottom: target.bottom - bounds.bottom,
        }
      })
      expect(geometry.outer.every((overflow) => overflow <= 1)).toBe(true)
      expect(geometry.bottom).toBeLessThanOrEqual(height)
      expect(geometry.itemTop).toBeGreaterThanOrEqual(-1)
      expect(geometry.itemBottom).toBeLessThanOrEqual(1)
      expect(Math.abs((await input.boundingBox())!.y - top)).toBeLessThanOrEqual(1)
      await input.fill("no-matching-file")
      const empty = popup.getByRole("status")
      await empty.waitFor()
      const emptyBounds = (await empty.boundingBox())!
      expect(emptyBounds.y + emptyBounds.height).toBeLessThanOrEqual(height)
      await page.keyboard.press("Escape")
      await popup.waitFor({ state: "hidden" })
    }
  }
  await page.setViewportSize({ width: 1100, height: 850 })
}, 30_000)

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

test("toolbar hover remains visible against its surface in both themes without moving glyphs", async () => {
  await page.setViewportSize({ width: 1100, height: 850 })
  await mount()
  const tools = page.getByRole("group", { name: "Review options", exact: true })
  for (const mode of ["light", "dark"]) {
    await page.evaluate(
      (value) => (window as unknown as { fixture: { theme(mode: string): void } }).fixture.theme(value),
      mode,
    )
    await page.waitForFunction((value) => document.documentElement.dataset.colorScheme === value, mode)
    for (const [label, hint] of [
      ["Review options", "Review options"],
      ["Jump to file", "Jump to file"],
      ["Refresh comparison", "Refresh comparison"],
      ["Wrap lines", "Disable line wrapping"],
      ["Collapse all", "Collapse all"],
      ["Diff layout: Auto", "Diff layout: Auto"],
      ["Hide files", "Hide files"],
    ]) {
      const button = tools.getByRole("button", { name: label, exact: true })
      const appearance = () =>
        button.evaluate(async (element) => {
          await Promise.all(element.getAnimations().map((animation) => animation.finished))
          const style = getComputedStyle(element)
          const icon = element.querySelector("svg")!
          return {
            background: style.backgroundColor,
            surface: getComputedStyle(element.closest(".review-toolbar-tools")!).backgroundColor,
            color: style.color,
            iconColor: getComputedStyle(icon).color,
            bounds: element.getBoundingClientRect().toJSON(),
            iconBounds: icon.getBoundingClientRect().toJSON(),
            pressed: element.getAttribute("aria-pressed") === "true",
            hovered: element.matches(":hover"),
          }
        })
      await page.mouse.move(0, 0)
      const before = await appearance()
      await button.hover()
      await page.getByRole("tooltip", { name: hint, exact: true }).waitFor()
      const hovered = await appearance()
      expect(hovered.hovered).toBe(true)
      expect(hovered.background).not.toBe(before.background)
      expect(hovered.background).not.toBe(hovered.surface)
      expect(hovered.iconColor).toBe(hovered.color)
      if (before.pressed) expect(hovered.color).toBe(before.color)
      else expect(hovered.color).not.toBe(before.color)
      expect(hovered.bounds).toEqual(before.bounds)
      expect(hovered.iconBounds).toEqual(before.iconBounds)
    }
  }
  expect(errors).toEqual([])
}, 30_000)

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
  for (const width of [375, 320, 560, 658, 700, 1100]) {
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
    const source = await page.getByRole("button", { name: "Comparison: Session", exact: true }).boundingBox()
    expect(source).not.toBeNull()
    if (width >= 560) expect(geometry[0]!.y + 16).toBeCloseTo(source!.y + source!.height / 2)
    else expect(geometry[0]!.y).toBeGreaterThanOrEqual(source!.y + source!.height)
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
  await page.setViewportSize({ width: 1100, height: 850 })
  comparisonRows = rows()
  hold = true
  failing = false
  errors.length = 0
  await page.goto(base)
  await page.getByRole("status").getByText("Loading comparison…", { exact: true }).waitFor()
  await page.locator("#root").evaluate((element) => (element.style.height = "120px"))
  const clipped = await page.locator(".review-content").evaluate((element) => {
    const content = element.getBoundingClientRect()
    const state = element.querySelector(".review-state")!.getBoundingClientRect()
    return state.top < content.top || state.bottom > content.bottom
  })
  expect(clipped).toBe(false)
  await page.locator("#root").evaluate((element) => (element.style.height = "100%"))
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
  await page.getByRole("option", { name: "Branch", exact: true }).waitFor({ state: "detached" })
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Comparison: Branch")
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
  const changed = page.getByRole("button", { name: "Comparison: origin/main → feature", exact: true })
  await changed.waitFor()
  expect(compared).toEqual({ from: "origin/main", to: "feature" })
  await changed.click()
  const from = "origin/a-long-base-reference-for-review-toolbar-layout"
  const to = "feature/a-long-target-reference-for-review-toolbar-layout"
  await page.getByRole("textbox", { name: "Base reference", exact: true }).fill(from)
  await page.getByRole("textbox", { name: "Target reference", exact: true }).fill(to)
  await page.getByRole("button", { name: "Compare", exact: true }).click()
  const long = page.getByRole("button", { name: `Comparison: ${from} → ${to}`, exact: true })
  await long.waitFor()
  for (const width of [320, 700]) {
    await page.setViewportSize({ width, height: 850 })
    const bounds = await page
      .locator(".review-toolbar button, .review-totals")
      .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().toJSON()))
    expect(bounds.every((box) => box.width > 0 && box.x >= 0 && box.right <= width)).toBe(true)
    await long.click()
    expect(await page.getByRole("textbox", { name: "Base reference", exact: true }).inputValue()).toBe(from)
    await page.keyboard.press("Escape")
  }
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
  await page.getByRole("button", { name: "Copy path", exact: true }).click()
  await page.getByRole("button", { name: "Copy path", exact: true }).waitFor({ state: "hidden" })
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "File options")
  await header.getByRole("button", { name: "File options", exact: true }).click()
  await page
    .locator('[data-component="popover-content"]')
    .getByRole("button", { name: "File versions", exact: true })
    .click()
  await page.getByRole("dialog", { name: "src/first.ts", exact: true }).waitFor()
  await page.getByRole("button", { name: "Copy path", exact: true }).waitFor({ state: "hidden" })
  await page.keyboard.press("Escape")
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "File options")
  await header.locator('[data-slot="checkbox-checkbox-control"]').click()
  await header.locator('[data-component="checkbox"][data-checked]').waitFor()
  expect(await header.getByRole("checkbox", { name: "Mark as viewed", exact: true }).isChecked()).toBe(true)
  expect(errors).toEqual([])
}, 30_000)

test("short version dialogs keep version controls reachable with one content scroller", async () => {
  await page.setViewportSize({ width: 700, height: 320 })
  await mount([{ ...rows()[0]!, file: "huge.ts" }])
  await page.getByRole("button", { name: "File versions", exact: true }).first().click()
  const dialog = page.getByRole("dialog", { name: "huge.ts", exact: true })
  await dialog.waitFor()
  await dialog.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)))
  const geometry = await dialog.evaluate((element) => {
    const body = element.querySelector('[data-slot="dialog-body"]')!
    const controls = element.querySelector(".review-version-controls")!.getBoundingClientRect()
    const bounds = element.getBoundingClientRect()
    return {
      overflow: body.scrollHeight - body.clientHeight,
      top: bounds.top,
      bottom: bounds.bottom,
      controls: controls.top,
    }
  })
  expect(geometry.overflow).toBeLessThanOrEqual(1)
  expect(geometry.top).toBeGreaterThanOrEqual(0)
  expect(geometry.bottom).toBeLessThanOrEqual(320)
  await dialog.locator(".review-version-content").focus()
  await page.keyboard.press("End")
  await page.waitForFunction(() => document.querySelector(".review-version-content")!.scrollTop > 0)
  expect(
    Math.abs((await dialog.locator(".review-version-controls").boundingBox())!.y - geometry.controls),
  ).toBeLessThanOrEqual(1)
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click()
  await dialog.waitFor({ state: "hidden" })
  await page.setViewportSize({ width: 1100, height: 850 })
})

test("file headers adapt to the reading width with both directory and comments open", async () => {
  await page.setViewportSize({ width: 1100, height: 850 })
  await mount()
  await page.locator("#root").evaluate((element) => (element.style.width = "800px"))
  await page.getByRole("button", { name: "Review options", exact: true }).click()
  await page.getByRole("button", { name: "Review comments", exact: true }).click()
  await page.getByRole("complementary", { name: "Review comments", exact: true }).waitFor()
  const header = page.locator(".review-file-header").first()
  const geometry = await header.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    return {
      clipped: [...element.querySelectorAll<HTMLElement>('button, [data-component="checkbox"]')]
        .filter((item) => item.checkVisibility())
        .some((item) => item.getBoundingClientRect().right > bounds.right),
      name: element.querySelector(".review-file-basename")!.getBoundingClientRect().width,
    }
  })
  expect(geometry.clipped).toBe(false)
  expect(geometry.name).toBeGreaterThan(40)
  await header.getByRole("button", { name: "File options", exact: true }).click()
  const menu = page.locator('[data-component="popover-content"]')
  expect(await menu.getByRole("button", { name: "Open current file", exact: true }).isEnabled()).toBe(true)
  await menu.getByRole("button", { name: "File versions", exact: true }).click()
  await page.getByRole("dialog", { name: "src/first.ts", exact: true }).waitFor()
  await page.keyboard.press("Escape")
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "File options")
})

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
      const geometry = await header.evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        const targets = [...element.querySelectorAll<HTMLElement>('button, [data-component="checkbox"]')]
          .filter((item) => item.checkVisibility())
          .map((item) => item.getBoundingClientRect())
        return {
          clipped: targets.some(
            (item) =>
              item.left < bounds.left ||
              item.right > bounds.right ||
              item.top < bounds.top ||
              item.bottom > bounds.bottom,
          ),
          name: element.querySelector(".review-file-basename")!.getBoundingClientRect().width,
        }
      })
      expect(geometry.clipped).toBe(false)
      expect(geometry.name).toBeGreaterThan(40)
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

test("localized pending file headers retain names and actions in narrow reading panes", async () => {
  await page.setViewportSize({ width: 1100, height: 850 })
  await mount([{ ...rows()[0]!, file: "src/components/a-long-component-filename.tsx" }], true)
  for (const locale of ["en", "zh-CN", "pseudo"]) {
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        ({ locale, theme }) => {
          const fixture = (
            window as unknown as { fixture: { locale(value: string): void; theme(value: string): void } }
          ).fixture
          fixture.locale(locale)
          fixture.theme(theme)
        },
        { locale, theme },
      )
      for (const width of [320, 375, 800]) {
        await page.locator("#root").evaluate((element, width) => (element.style.width = `${width}px`), width)
        const geometry = await page
          .locator(".review-file-header")
          .first()
          .evaluate((element) => {
            const bounds = element.getBoundingClientRect()
            const buttons = [...element.querySelectorAll<HTMLButtonElement>("button")].filter((item) =>
              item.checkVisibility(),
            )
            return {
              clipped: buttons.some((item) => item.getBoundingClientRect().right > bounds.right),
              named: buttons.every((button) => !!button.getAttribute("aria-label")),
              name: element.querySelector(".review-file-basename")!.getBoundingClientRect().width,
            }
          })
        expect(geometry.clipped).toBe(false)
        expect(geometry.named).toBe(true)
        expect(geometry.name).toBeGreaterThan(40)
      }
    }
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
    const lineBounds = async () => {
      // Virtual rows can be replaced between locator resolution and element evaluation.
      const handle = await page.waitForFunction((label) => {
        const containers = document.querySelectorAll('[data-component="review-viewer"] diffs-container')
        for (const container of containers) {
          for (const row of container.shadowRoot?.querySelectorAll<HTMLElement>("[data-column-number]") ?? []) {
            if (row.getAttribute("aria-label") !== label || !row.isConnected) continue
            const rect = row.getBoundingClientRect()
            if (rect.width > 0 && rect.height > 0) return { y: rect.y }
          }
        }
      }, name)
      const bounds = await handle.jsonValue()
      await handle.dispose()
      if (!bounds) throw new Error("Expected a rendered selected line")
      return bounds
    }
    const before = await lineBounds()
    for (const action of ["files", "wrap", "layout"] as const) {
      if (action === "files") await page.getByRole("button", { name: "Hide files", exact: true }).click()
      else if (action === "wrap") await page.getByRole("button", { name: "Wrap lines", exact: true }).click()
      else {
        await page.getByRole("button", { name: /^Diff layout:/ }).click()
        await page.getByRole("option", { name: "Unified", exact: true }).click()
      }
      const after = await lineBounds()
      expect(Math.abs(after.y - before.y)).toBeLessThan(30)
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
  await page.getByRole("button", { name: "Show files", exact: true }).click()
  const popupTree = page.getByRole("tree", { name: "Files", exact: true })
  await popupTree.waitFor()
  const popupBounds = (await page.locator(".review-files-popover").boundingBox())!
  expect(popupBounds.y).toBeGreaterThanOrEqual(0)
  expect(popupBounds.y + popupBounds.height).toBeLessThanOrEqual(850)
  await popupTree.getByRole("treeitem").first().press("End")
  await page.waitForFunction(() => document.activeElement?.getAttribute("title") === "src/long-directory/file-4999.ts")
  await page.keyboard.press("Escape")
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Show files")
  await page.setViewportSize({ width: 1100, height: 850 })
  const sidebar = page.getByRole("complementary", { name: "Files", exact: true })
  const tree = sidebar.getByRole("tree", { name: "Files", exact: true })
  await tree.waitFor()
  for (const height of [780, 500]) {
    await page.locator("#root").evaluate((element, height) => (element.style.height = `${height}px`), height)
    const geometry = await sidebar.evaluate((element) => {
      const navigation = element.querySelector<HTMLElement>(".review-navigation")!
      const tree = element.querySelector<HTMLElement>('[role="tree"]')!
      return {
        availableBottom:
          element.getBoundingClientRect().bottom - parseFloat(getComputedStyle(navigation).paddingBottom),
        treeBottom: tree.getBoundingClientRect().bottom,
        sidebarOverflow: element.scrollHeight - element.clientHeight,
        navigationOverflow: navigation.scrollHeight - navigation.clientHeight,
      }
    })
    expect(Math.abs(geometry.treeBottom - geometry.availableBottom)).toBeLessThanOrEqual(1)
    expect(geometry.sidebarOverflow).toBe(0)
    expect(geometry.navigationOverflow).toBe(0)
  }
  expect(await tree.getByRole("treeitem").count()).toBeLessThan(80)
  const filter = sidebar.getByRole("textbox", { name: "Filter files…", exact: true })
  const filterTop = (await filter.boundingBox())!.y
  await tree.getByRole("treeitem").first().press("End")
  await page.waitForFunction(() => document.activeElement?.getAttribute("title") === "src/long-directory/file-4999.ts")
  const focused = await tree.evaluate((element) => {
    const row = element.querySelector<HTMLElement>('[role="treeitem"]:focus')!
    return { tree: element.getBoundingClientRect().toJSON(), row: row.getBoundingClientRect().toJSON() }
  })
  expect(focused.row.y).toBeGreaterThanOrEqual(focused.tree.y)
  expect(focused.row.bottom).toBeLessThanOrEqual(focused.tree.bottom)
  expect((await filter.boundingBox())!.y).toBe(filterTop)
  await filter.fill("file-4999.ts")
  await tree.getByRole("treeitem", { name: /file-4999/ }).waitFor()
  expect((await filter.boundingBox())!.y).toBe(filterTop)
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
  const source = await page.getByRole("button", { name: "Comparison: Session", exact: true }).boundingBox()
  const tools = await wrap.boundingBox()
  expect(source && tools && Math.abs(source.y + source.height / 2 - tools.y - tools.height / 2)).toBeLessThan(1)
  await wrap.click()
  expect(await wrap.getAttribute("aria-pressed")).toBe("false")
  expect(errors).toEqual([])
  await page.emulateMedia({ reducedMotion: "no-preference" })
})
