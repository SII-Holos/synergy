import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { build, normalizePath } from "vite"
import solid from "vite-plugin-solid"

const MIXED = "重接 Agent WorkItem/Invocation 传输与 trace，保留物理生命周期并删除旧壳层"
const LONG = "逐条核验真实 PostgreSQL、Agent Lab/模型、浏览器交互/响应式/动画、macOS 与 Windows 窗口链路"

let fixture: string
let server: ReturnType<typeof Bun.serve>
let browser: Browser
let page: Page
const errors: string[] = []

beforeAll(async () => {
  const cache = path.resolve(import.meta.dir, "../../node_modules/.cache")
  await mkdir(cache, { recursive: true })
  fixture = await mkdtemp(path.join(cache, "dag-graph-"))
  const component = (name: string) =>
    JSON.stringify(`/@fs/${normalizePath(path.resolve(import.meta.dir, `../../src/components/${name}.tsx`))}`)
  // The clipping under test comes from the real card box (padding + fixed
  // height + overflow), so the stylesheet must be present or the assertion
  // passes against a component that clips in the product.
  const stylesheet = await Bun.file(path.resolve(import.meta.dir, "../../src/components/dag-graph.css")).text()
  await Bun.write(
    path.join(fixture, "index.html"),
    `<style>
      body { margin: 0; font-family: "Helvetica Neue", Helvetica, sans-serif; font-size: 14px; line-height: 20px; }
      :root {
        --text-base:#1d1d1d; --text-weak:#4f4f4f; --surface-raised-base:#fff; --surface-base:#fff;
        --border-weak-base:#e5e5e5; --border-weak-hover:#ccc; --border-base:#ccc; --border-weaker-base:#eee;
        --surface-base-hover:#f5f5f5; --surface-inset-base:#fafafa; --text-interactive-base:#2f6fed;
        --border-interactive-base:#2f6fed; --surface-info-weak:#eef4ff; --text-on-success-base:#1a7f37;
        --border-success-base:#1a7f37; --surface-success-weak:#eef8f1; --text-on-critical-base:#c0392b;
        --border-critical-base:#c0392b; --surface-critical-weak:#fdeeec; --text-on-warning-base:#8a6d00;
        --border-warning-base:#8a6d00; --surface-warning-weak:#fdf6e3;
      }
      ${stylesheet}
    </style><div id="root"></div><script type="module" src="/main.tsx"></script>`,
  )
  await Bun.write(
    path.join(fixture, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {I18nProvider} from "@lingui/solid"
    import {setupI18n} from "@lingui/core"
    import {DagGraph} from ${component("dag-graph")}
    const i18n = setupI18n({locale:"zh-CN", messages:{}})
    const nodes = [
      {id:"root", status:"running", deps:[], content:"Provider/Consumer 架构收敛"},
      {id:"a", status:"pending", deps:["root"], content:${JSON.stringify(MIXED)}},
      {id:"b", status:"pending", deps:["root"], content:${JSON.stringify(LONG)}},
      {id:"c", status:"pending", deps:["a","b"], content:"实现唯一 Assistant Inbox 和 WorkItem Workbench，替换 Conversation/Orb"},
    ]
    render(() => <I18nProvider i18n={i18n}>
      <div style={{"max-width":"620px"}}>
        <DagGraph nodes={nodes} enableInspector={false} />
      </div>
    </I18nProvider>, document.getElementById("root"))
  `,
  )
  const dist = path.join(fixture, "dist")
  const plugin = normalizePath(path.resolve(import.meta.dir, "../../../plugin/src"))
  const sdk = normalizePath(path.resolve(import.meta.dir, "../../../sdk/js/src"))
  const util = normalizePath(path.resolve(import.meta.dir, "../../../util/src"))
  await build({
    configFile: false,
    root: fixture,
    plugins: [solid()],
    logLevel: "error",
    resolve: {
      alias: [
        { find: /^@ericsanchezok\/synergy-plugin\/(.*)$/, replacement: `${plugin}/$1` },
        { find: /^@ericsanchezok\/synergy-sdk\/(.*)$/, replacement: `${sdk}/$1` },
        { find: /^@ericsanchezok\/synergy-util\/(.*)$/, replacement: `${util}/$1` },
      ],
    },
    build: { outDir: dist, target: "esnext", minify: false },
  })
  const assets = new Map<string, ReturnType<typeof Bun.file>>()
  for await (const file of new Bun.Glob("**/*").scan(dist)) assets.set(`/${file}`, Bun.file(path.join(dist, file)))
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname
      const file = assets.get(pathname === "/" ? "/index.html" : pathname)
      return file ? new Response(file) : new Response("Not found", { status: 404 })
    },
  })
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 900, height: 800 } })
  page.setDefaultTimeout(8000)
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(server.url.toString())
  await page.locator('[data-slot="dag-graph-card"]').first().waitFor()
  await settle()
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await server?.stop(true)
  if (fixture) await rm(fixture, { recursive: true, force: true })
}, 30_000)

async function settle() {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  )
}

test("card text is not clipped when content mixes CJK and Latin", async () => {
  const cards = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-slot="dag-graph-card"]')].map((card) => {
      const content = card.querySelector<HTMLElement>('[data-slot="dag-graph-card-content"]')!
      const button = card.querySelector<HTMLElement>('[data-slot="dag-graph-node-action"]')!
      return {
        id: card.dataset.id!,
        text: content.textContent ?? "",
        clipped: content.scrollHeight - content.clientHeight,
        buttonClipped: button.scrollHeight - button.clientHeight,
      }
    }),
  )

  expect(cards.length).toBe(4)
  for (const card of cards) {
    expect({ id: card.id, clipped: card.clipped }).toEqual({ id: card.id, clipped: 0 })
    expect({ id: card.id, clipped: card.buttonClipped }).toEqual({ id: card.id, clipped: 0 })
  }
  expect(errors).toEqual([])
})

test("a long card grows past the estimated height instead of truncating", async () => {
  const heights = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-slot="dag-graph-card"]')].map((card) => ({
      id: card.dataset.id!,
      height: card.offsetHeight,
    })),
  )
  const byId = new Map(heights.map((item) => [item.id, item.height]))
  expect(byId.get("root")).toBeGreaterThanOrEqual(108)
  expect(byId.get("b")).toBeGreaterThan(108)
})

test("auto focus keeps the active layer and its next row on screen", async () => {
  const result = await page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('[data-slot="dag-graph-viewport"]')!.getBoundingClientRect()
    return [...document.querySelectorAll<HTMLElement>('[data-slot="dag-graph-card"]')].map((card) => {
      const rect = card.getBoundingClientRect()
      return {
        id: card.dataset.id!,
        left: rect.left - viewport.left,
        right: rect.right - viewport.left,
        top: rect.top - viewport.top,
        bottom: rect.bottom - viewport.top,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
      }
    })
  })

  // The running card and the row it leads into are what auto focus frames; a
  // deeper row stays off screen by design and is reached by panning.
  const framed = new Set(["root", "a", "b"])
  for (const card of result.filter((item) => framed.has(item.id))) {
    const withinX = card.left >= -2 && card.right <= card.viewportWidth + 2
    const withinY = card.top >= -2 && card.bottom <= card.viewportHeight + 2
    expect({ id: card.id, withinX, withinY }).toEqual({ id: card.id, withinX: true, withinY: true })
  }
})
