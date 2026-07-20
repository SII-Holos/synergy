import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, webkit } from "playwright"

const appDir = fileURLToPath(new URL("..", import.meta.url))

type CssRuleContract = {
  selector: string
  declarations: string[]
}

const rootRuleContracts: CssRuleContract[] = [
  {
    selector: "[data-component=markdown]",
    declarations: [
      "width:100%",
      "min-width:0",
      "max-width:100%",
      "overflow-wrap:break-word",
      "color:var(--text-base)",
      "font-family:var(--font-family-sans)",
      "font-size:var(--font-size-base)",
      "line-height:1.68",
    ],
  },
  {
    selector: "[data-component=button]",
    declarations: [
      "display:inline-flex",
      "align-items:center",
      "justify-content:center",
      "border-style:solid",
      "border-width:1px",
      "border-radius:var(--radius-md)",
      "text-decoration:none",
      "user-select:none",
    ],
  },
  {
    selector: "[data-component=icon]",
    declarations: [
      "display:inline-flex",
      "align-items:center",
      "justify-content:center",
      "flex-shrink:0",
      "aspect-ratio:1",
      "color:var(--icon-base)",
    ],
  },
  {
    selector: "[data-component=countdown]",
    declarations: [
      "font-family:var(--font-family-sans)",
      "font-size:var(--font-size-small)",
      "font-variant-numeric:tabular-nums",
      "font-weight:var(--font-weight-medium)",
      "line-height:var(--line-height-large)",
      "color:var(--text-weak)",
      "flex-shrink:0",
    ],
  },
  {
    selector: "[data-component=file-icon]",
    declarations: ["flex-shrink:0", "width:16px", "height:16px"],
  },
  {
    selector: "[data-component=popover-content]",
    declarations: [
      "z-index:50",
      "min-width:200px",
      "max-width:320px",
      "border-radius:var(--radius-xl)",
      "background-color:var(--workbench-popover-bg",
      "transform-origin:var(--kb-popover-content-transform-origin)",
    ],
  },
  {
    selector: ".statusbar-subsession-popover[data-component=popover-content]",
    declarations: ["width:min(24rem,100vw - 24px)", "max-width:min(24rem,100vw - 24px)"],
  },
  {
    selector: ".statusbar-subsession-popover[data-component=popover-content] [data-slot=popover-body]>*",
    declarations: ["width:100%"],
  },
  {
    selector: "[data-component=session-turn]",
    declarations: [
      "height:100%",
      "min-height:0",
      "min-width:0",
      "display:flex",
      "align-items:flex-start",
      "justify-content:flex-start",
    ],
  },
  {
    selector: "[data-component=dialog]",
    declarations: [
      "position:fixed",
      "inset:0",
      "margin-left:var(--dialog-left-margin)",
      "z-index:50",
      "display:flex",
      "align-items:center",
      "justify-content:center",
    ],
  },
]

const fileWorkbenchRuleContracts: CssRuleContract[] = [
  {
    selector: ".file-workbench",
    declarations: ["display:flex", "height:100%", "min-width:0", "flex-direction:column", "overflow:hidden"],
  },
  {
    selector: ".file-workbench-main",
    declarations: [
      "position:relative",
      "display:flex",
      "min-height:0",
      "min-width:0",
      "flex:1",
      "overflow:hidden",
      "container-type:inline-size",
    ],
  },
  {
    selector: ".file-explorer",
    declarations: ["position:relative", "display:flex", "min-width:220px", "flex-shrink:0", "flex-direction:column"],
  },
]

type ViteManifestChunk = {
  src?: string
  file: string
  css?: string[]
  imports?: string[]
  isEntry?: boolean
  isDynamicEntry?: boolean
}

type CssRuleMatch = {
  body: string
  ancestors: string[]
}

function findBlockStart(css: string, start: number, end: number): number {
  let quote: string | undefined
  for (let index = start; index < end; index++) {
    const char = css[index]
    if (quote) {
      if (char === "\\") index++
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === "/" && css[index + 1] === "*") {
      const commentEnd = css.indexOf("*/", index + 2)
      return commentEnd === -1 ? -1 : findBlockStart(css, commentEnd + 2, end)
    }
    if (char === "{") return index
  }
  return -1
}

function findBlockEnd(css: string, blockStart: number, end: number): number {
  let depth = 1
  let quote: string | undefined
  for (let index = blockStart + 1; index < end; index++) {
    const char = css[index]
    if (quote) {
      if (char === "\\") index++
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === "/" && css[index + 1] === "*") {
      const commentEnd = css.indexOf("*/", index + 2)
      if (commentEnd === -1) return -1
      index = commentEnd + 1
      continue
    }
    if (char === "{") depth++
    if (char !== "}") continue
    depth--
    if (depth === 0) return index
  }
  return -1
}

function collectRuleMatches(css: string, selector: string): CssRuleMatch[] {
  const matches: CssRuleMatch[] = []

  function scan(start: number, end: number, ancestors: string[]) {
    let cursor = start
    while (cursor < end) {
      const blockStart = findBlockStart(css, cursor, end)
      if (blockStart === -1) return
      const blockEnd = findBlockEnd(css, blockStart, end)
      if (blockEnd === -1) return

      const rawPrelude = css
        .slice(cursor, blockStart)
        .replaceAll(/\/\*[\s\S]*?\*\//g, "")
        .trim()
      const prelude = rawPrelude.slice(rawPrelude.lastIndexOf(";") + 1).trim()
      if (prelude.startsWith("@")) {
        scan(blockStart + 1, blockEnd, [...ancestors, prelude])
      } else {
        const selectors = prelude.split(",").map((item) => item.trim())
        if (selectors.includes(selector)) {
          matches.push({ body: css.slice(blockStart + 1, blockEnd), ancestors })
        }
      }
      cursor = blockEnd + 1
    }
  }

  scan(0, css.length, [])
  return matches
}

function collectRootRuleBodies(css: string, selector: string): string[] {
  return collectRuleMatches(css, selector)
    .filter((match) => !match.ancestors.some((ancestor) => ancestor.startsWith("@media")))
    .map((match) => match.body)
}

function isReducedMotionAtRule(prelude: string): boolean {
  return prelude.replaceAll(/\s/g, "").includes("@media(prefers-reduced-motion:reduce)")
}

describe("CSS rule collection", () => {
  test("keeps media-query rules out of root selector results", () => {
    const selector = "[data-component=compaction-card][data-status=running]:before"
    const css = `/*! generated CSS */@layer base{${selector}{animation:compaction-card-shimmer}@media (prefers-reduced-motion: reduce){${selector}{animation:none}}}`

    expect(collectRootRuleBodies(css, selector)).toEqual(["animation:compaction-card-shimmer"])
    expect(collectRuleMatches(css, selector)).toEqual([
      { body: "animation:compaction-card-shimmer", ancestors: ["@layer base"] },
      {
        body: "animation:none",
        ancestors: ["@layer base", "@media (prefers-reduced-motion: reduce)"],
      },
    ])
  })
})

function expectRootRule(css: string, contract: CssRuleContract) {
  const bodies = collectRootRuleBodies(css, contract.selector)
  expect(bodies.length, `Missing root CSS rule for ${contract.selector}`).toBeGreaterThan(0)

  const combinedBody = bodies.join(";")
  if (contract.declarations.every((declaration) => combinedBody.includes(declaration))) return

  throw new Error(
    `Missing declarations for ${contract.selector} in built CSS:\n` +
      contract.declarations.map((declaration) => `  ${declaration}`).join("\n") +
      `\nFound root bodies:\n` +
      bodies.map((body) => `  ${body.slice(0, 240)}`).join("\n"),
  )
}

async function readBuiltCss(outDir: string) {
  const assetsDir = path.join(outDir, "assets")
  const assets = await readdir(assetsDir)
  const cssFiles = assets.filter((file) => file.endsWith(".css"))
  expect(cssFiles.length).toBeGreaterThan(0)

  const chunks = await Promise.all(cssFiles.map((file) => readFile(path.join(assetsDir, file), "utf8")))
  return chunks.join("\n")
}

async function readBuiltManifest(outDir: string): Promise<Record<string, ViteManifestChunk>> {
  return JSON.parse(await readFile(path.join(outDir, ".vite", "manifest.json"), "utf8"))
}

function collectManifestCss(manifest: Record<string, ViteManifestChunk>, roots: string[]) {
  const visited = new Set<string>()
  const css = new Set<string>()

  const visit = (key: string) => {
    if (visited.has(key)) return
    visited.add(key)
    const chunk = manifest[key]
    if (!chunk) return
    for (const file of chunk.css ?? []) css.add(file)
    for (const imported of chunk.imports ?? []) visit(imported)
  }

  for (const root of roots) visit(root)
  return [...css]
}

async function readCssAssets(outDir: string, files: string[]) {
  return (await Promise.all(files.map((file) => readFile(path.join(outDir, file), "utf8")))).join("\n")
}

async function readBuiltIndex(outDir: string) {
  return readFile(path.join(outDir, "index.html"), "utf8")
}

async function readBuiltAssets(outDir: string) {
  return readdir(path.join(outDir, "assets"))
}
async function readBuiltJavaScript(outDir: string) {
  const assets = await readBuiltAssets(outDir)
  const javascriptFiles = assets.filter((file) => file.endsWith(".js"))
  return new Map(
    await Promise.all(
      javascriptFiles.map(async (file) => [file, await readFile(path.join(outDir, "assets", file), "utf8")] as const),
    ),
  )
}

function initialJavaScriptAssets(index: string) {
  return [...index.matchAll(/(?:src|href)="(?:\.\/)?assets\/([^"?]+\.js)(?:\?[^"]*)?"/g)].map((match) => match[1]!)
}

async function expectSessionWorkbenchPaneTracksBottomSurface(css: string) {
  const browserType = process.env.SYNERGY_APP_LAYOUT_BROWSER === "webkit" ? webkit : chromium
  const browser = await browserType.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
    await page.setContent(`
      <style>
        html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
        ${css}
      </style>
      <main class="relative size-full overflow-hidden flex flex-col contain-[layout_style_paint]">
        <div class="synergy-workbench-canvas relative size-full overflow-hidden flex flex-col">
          <div class="flex-1 min-h-0 flex flex-col md:flex-row relative">
            <div data-pane class="session-workbench-pane relative flex flex-col flex-1">
              <div data-prompt class="absolute inset-x-0 bottom-0 h-20"></div>
            </div>
          </div>
          <div
            data-bottom
            class="workbench-surface workbench-surface--bottom workbench-surface--resizing"
          ></div>
        </div>
      </main>
    `)

    const bottom = page.locator("[data-bottom]")
    for (const bottomHeight of [0, 280, 480]) {
      await bottom.evaluate((element, height) => {
        element.style.height = `${height}px`
      }, bottomHeight)

      const layout = await page.evaluate(() => {
        const pane = document.querySelector<HTMLElement>("[data-pane]")
        const prompt = document.querySelector<HTMLElement>("[data-prompt]")
        const bottomSurface = document.querySelector<HTMLElement>("[data-bottom]")
        if (!pane || !prompt || !bottomSurface) throw new Error("Missing session layout fixture")

        const paneRect = pane.getBoundingClientRect()
        const promptRect = prompt.getBoundingClientRect()
        const bottomRect = bottomSurface.getBoundingClientRect()
        return {
          paneHeight: paneRect.height,
          paneBottom: paneRect.bottom,
          promptBottom: promptRect.bottom,
          bottomTop: bottomRect.top,
        }
      })

      expect(Math.abs(layout.paneHeight - (800 - bottomHeight))).toBeLessThanOrEqual(1)
      expect(Math.abs(layout.paneBottom - layout.bottomTop)).toBeLessThanOrEqual(1)
      expect(Math.abs(layout.promptBottom - layout.bottomTop)).toBeLessThanOrEqual(1)
    }
  } finally {
    await browser.close()
  }
}

async function expectPromptDockKeepsReadableWidth(css: string) {
  const browserType = process.env.SYNERGY_APP_LAYOUT_BROWSER === "webkit" ? webkit : chromium
  const browser = await browserType.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 240 } })
    await page.setContent(`
      <style>
        html, body { width: 100%; height: 100%; margin: 0; }
        ${css}
      </style>
      <main data-frame style="display: flex; justify-content: center; width: 100%;">
        <div data-prompt class="session-prompt-dock-content w-full" style="height: 80px;"></div>
      </main>
    `)

    const measure = () =>
      page.evaluate(() => {
        const frame = document.querySelector<HTMLElement>("[data-frame]")
        const prompt = document.querySelector<HTMLElement>("[data-prompt]")
        if (!frame || !prompt) throw new Error("Missing prompt dock layout fixture")
        const frameRect = frame.getBoundingClientRect()
        const promptRect = prompt.getBoundingClientRect()
        return {
          frameWidth: frameRect.width,
          promptWidth: promptRect.width,
          leftInset: promptRect.left - frameRect.left,
          rightInset: frameRect.right - promptRect.right,
        }
      })

    const desktop = await measure()
    expect(desktop.promptWidth).toBe(864)
    expect(Math.abs(desktop.leftInset - desktop.rightInset)).toBeLessThanOrEqual(1)

    await page.setViewportSize({ width: 640, height: 240 })
    const narrow = await measure()
    expect(narrow.promptWidth).toBe(narrow.frameWidth)
  } finally {
    await browser.close()
  }
}

async function expectSessionInboxBadgePreservesIconCenter(css: string) {
  const browserType = process.env.SYNERGY_APP_LAYOUT_BROWSER === "webkit" ? webkit : chromium
  const browser = await browserType.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 160 } })
    await page.setContent(`
      <style>${css}</style>
      <button
        data-trigger="empty"
        class="session-inbox-trigger statusbar-glass relative flex size-9 items-center justify-center rounded-full"
      >
        <span data-icon></span>
      </button>
      <button
        data-trigger="active"
        class="session-inbox-trigger statusbar-glass relative flex size-9 items-center justify-center rounded-full"
      >
        <span data-icon></span>
        <span data-badge class="session-inbox-badge">1</span>
      </button>
      <style>[data-icon] { display: block; width: 16px; height: 16px; }</style>
    `)

    const layout = await page.evaluate(() => {
      const centerOffset = (trigger: Element, icon: Element) => {
        const triggerRect = trigger.getBoundingClientRect()
        const iconRect = icon.getBoundingClientRect()
        return iconRect.left + iconRect.width / 2 - (triggerRect.left + triggerRect.width / 2)
      }
      const emptyTrigger = document.querySelector('[data-trigger="empty"]')
      const emptyIcon = emptyTrigger?.querySelector("[data-icon]")
      const activeTrigger = document.querySelector('[data-trigger="active"]')
      const activeIcon = activeTrigger?.querySelector("[data-icon]")
      const badge = document.querySelector("[data-badge]")
      if (!emptyTrigger || !emptyIcon || !activeTrigger || !activeIcon || !badge) {
        throw new Error("Missing session inbox fixture")
      }

      return {
        emptyIconOffset: centerOffset(emptyTrigger, emptyIcon),
        activeIconOffset: centerOffset(activeTrigger, activeIcon),
        badgePosition: getComputedStyle(badge).position,
      }
    })

    expect(Math.abs(layout.emptyIconOffset)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(layout.activeIconOffset)).toBeLessThanOrEqual(0.5)
    expect(layout.badgePosition).toBe("absolute")
  } finally {
    await browser.close()
  }
}

async function expectStatusbarSubsessionContentFillsBody(css: string) {
  const browserType = process.env.SYNERGY_APP_LAYOUT_BROWSER === "webkit" ? webkit : chromium
  const browser = await browserType.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    for (const width of [800, 375]) {
      await page.setViewportSize({ width, height: 600 })
      await page.setContent(`
        <style>*, ::before, ::after { box-sizing: border-box; } ${css}</style>
        <div class="statusbar-subsession-popover" data-component="popover-content">
          <div data-slot="popover-body">
            <div data-content></div>
          </div>
        </div>
      `)

      const layout = await page.evaluate(() => {
        const body = document.querySelector<HTMLElement>('[data-slot="popover-body"]')
        const content = document.querySelector<HTMLElement>("[data-content]")
        if (!body || !content) throw new Error("Missing subsession popover fixture")

        const bodyStyle = getComputedStyle(body)
        const bodyRect = body.getBoundingClientRect()
        const contentRect = content.getBoundingClientRect()
        const paddingLeft = Number.parseFloat(bodyStyle.paddingLeft)
        const paddingRight = Number.parseFloat(bodyStyle.paddingRight)
        return {
          availableWidth: bodyRect.width - paddingLeft - paddingRight,
          contentWidth: contentRect.width,
          rightInset: bodyRect.right - paddingRight - contentRect.right,
        }
      })

      expect(Math.abs(layout.contentWidth - layout.availableWidth)).toBeLessThanOrEqual(0.5)
      expect(Math.abs(layout.rightInset)).toBeLessThanOrEqual(0.5)
    }
  } finally {
    await browser.close()
  }
}

async function expectFileWorkbenchExplorerResizeMatchesMode(css: string) {
  const browserType = process.env.SYNERGY_APP_LAYOUT_BROWSER === "webkit" ? webkit : chromium
  const browser = await browserType.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 600 } })
    await page.setContent(`
      <style>*, ::before, ::after { box-sizing: border-box; } ${css}</style>
      <div class="file-workbench" style="height: 480px;">
        <div class="file-workbench-main">
          <main class="file-viewer"></main>
          <aside class="file-explorer" style="width: 296px;">
            <div data-component="resize-handle" data-direction="horizontal" data-edge="start"></div>
          </aside>
        </div>
      </div>
    `)

    const measure = async (width: number) => {
      await page.locator(".file-workbench").evaluate((element, value) => {
        ;(element as HTMLElement).style.width = `${value}px`
      }, width)
      return page.evaluate(() => {
        const explorer = document.querySelector<HTMLElement>(".file-explorer")
        const handle = explorer?.querySelector<HTMLElement>('[data-component="resize-handle"]')
        if (!explorer || !handle) throw new Error("Missing file explorer layout fixture")
        return {
          explorerPosition: getComputedStyle(explorer).position,
          handleDisplay: getComputedStyle(handle).display,
        }
      })
    }

    expect(await measure(640)).toEqual({ explorerPosition: "absolute", handleDisplay: "none" })
    expect(await measure(800)).toEqual({ explorerPosition: "relative", handleDisplay: "block" })
  } finally {
    await browser.close()
  }
}

async function runAppBuild(outDir: string) {
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", "build", "--outDir", outDir, "--emptyOutDir", "--manifest"],
    cwd: appDir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NODE_ENV: "production", NO_COLOR: "1" },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode === 0) return

  throw new Error(`App build failed with exit code ${exitCode}\n${stdout}\n${stderr}`)
}

describe("app production build contract", () => {
  test("preserves core styles and keeps optional workbench resources off the initial route", async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), "synergy-app-dist-"))
    try {
      await runAppBuild(outDir)
      const [css, index, assets, javascript, manifest] = await Promise.all([
        readBuiltCss(outDir),
        readBuiltIndex(outDir),
        readBuiltAssets(outDir),
        readBuiltJavaScript(outDir),
        readBuiltManifest(outDir),
      ])

      for (const contract of rootRuleContracts) {
        expectRootRule(css, contract)
      }

      const initialManifestEntries = Object.entries(manifest)
        .filter(([, chunk]) => chunk.isEntry)
        .map(([key]) => key)
      const fileWorkbenchManifestEntry = Object.entries(manifest).find(
        ([, chunk]) => chunk.src === "src/components/file-workbench/content.tsx",
      )
      expect(initialManifestEntries.length, "Production manifest must include an initial entry").toBeGreaterThan(0)
      expect(fileWorkbenchManifestEntry, "Production manifest must include the lazy File workbench entry").toBeDefined()
      expect(fileWorkbenchManifestEntry![1].isDynamicEntry).toBe(true)

      const initialCss = await readCssAssets(outDir, collectManifestCss(manifest, initialManifestEntries))
      const fileWorkbenchCss = await readCssAssets(
        outDir,
        collectManifestCss(manifest, [fileWorkbenchManifestEntry![0]]),
      )
      for (const contract of fileWorkbenchRuleContracts) {
        expect(collectRootRuleBodies(initialCss, contract.selector)).toHaveLength(0)
        expectRootRule(fileWorkbenchCss, contract)
      }

      const expandedCompactionBodies = collectRootRuleBodies(
        css,
        "[data-component=compaction-card] [data-slot=collapsible-content][data-expanded]",
      )
      expect(expandedCompactionBodies.length, "Missing expanded compaction card CSS rule").toBeGreaterThan(0)
      expect(expandedCompactionBodies.join(";")).not.toContain(" both")
      const shimmerSelectors = [
        "[data-component=compaction-card][data-status=running]:before",
        "[data-component=compaction-card][data-status=running]::before",
      ]
      const runningCompactionShimmerRules = shimmerSelectors.flatMap((selector) => collectRuleMatches(css, selector))
      const rootShimmer = runningCompactionShimmerRules
        .filter((rule) => !rule.ancestors.some((ancestor) => ancestor.startsWith("@media")))
        .map((rule) => rule.body)
        .join(";")
      expect(rootShimmer, "Missing running compaction shimmer CSS rule").toContain("animation:compaction-card-shimmer")
      expect(rootShimmer).toContain("will-change:transform,opacity")

      const reducedMotionShimmer = runningCompactionShimmerRules
        .filter((rule) => rule.ancestors.some(isReducedMotionAtRule))
        .map((rule) => rule.body)
        .join(";")
      expect(reducedMotionShimmer, "Missing reduced-motion compaction shimmer override").toContain("animation:none")
      expect(reducedMotionShimmer).toContain("will-change:auto")
      expect(css).toContain("@keyframes compaction-card-shimmer{")

      expect(index).not.toMatch(/rel="modulepreload"[^>]+vendor-(?:mermaid|tiptap)/)
      const initialAssets = initialJavaScriptAssets(index)
      expect(initialAssets.length, "Production index must reference an initial JavaScript entry").toBeGreaterThan(0)
      const initialJavaScript = initialAssets.map((asset) => javascript.get(asset) ?? "").join("\n")
      const simplifiedChineseChunks = [...javascript.entries()].filter(
        ([asset, source]) =>
          asset.startsWith("messages-") && source.includes('"ui.list.loading"') && source.includes("正在加载"),
      )
      expect(simplifiedChineseChunks, "Simplified Chinese must be emitted as one lazy catalog chunk").toHaveLength(1)
      const [simplifiedChineseAsset] = simplifiedChineseChunks[0]!
      expect(index).not.toContain(simplifiedChineseAsset)
      expect(initialJavaScript).toContain("Loading...")
      expect(initialJavaScript).not.toContain("正在加载")
      expect([...javascript.keys()].filter((asset) => /pseudo/i.test(asset))).toEqual([])
      expect(
        [...javascript.entries()]
          .filter(([asset]) => asset.startsWith("messages-"))
          .some(([, source]) => source.includes("⟦") || source.includes("⟧")),
      ).toBe(false)
      expect([...javascript.values()].some((source) => source.includes("pseudoLocale"))).toBe(false)

      expect(assets.filter((asset) => asset.includes("NerdFont")).toSorted()).toEqual([
        expect.stringMatching(/^BlexMonoNerdFontMono-Bold-/),
        expect.stringMatching(/^BlexMonoNerdFontMono-Medium-/),
        expect.stringMatching(/^BlexMonoNerdFontMono-Regular-/),
      ])
      const markdownChunk = assets.find((asset) => asset.startsWith("vendor-markdown-") && asset.endsWith(".js"))
      expect(markdownChunk).toBeDefined()
      await expectSessionWorkbenchPaneTracksBottomSurface(css)
      await expectSessionInboxBadgePreservesIconCenter(css)
      await expectPromptDockKeepsReadableWidth(css)
      await expectStatusbarSubsessionContentFillsBody(css)
      await expectFileWorkbenchExplorerResizeMatchesMode(css)
      expect((await stat(path.join(outDir, "assets", markdownChunk!))).size).toBeLessThan(200_000)
    } finally {
      await rm(outDir, { recursive: true, force: true })
    }
  }, 60_000)
})
