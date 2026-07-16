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

function collectRootRuleBodies(css: string, selector: string): string[] {
  const bodies: string[] = []
  let searchIndex = 0

  while (searchIndex < css.length) {
    const selectorIndex = css.indexOf(selector, searchIndex)
    if (selectorIndex === -1) break
    searchIndex = selectorIndex + selector.length

    const blockStart = css.indexOf("{", selectorIndex)
    if (blockStart === -1) break
    const ruleStart = Math.max(css.lastIndexOf("}", selectorIndex), css.lastIndexOf("{", selectorIndex)) + 1
    const prelude = css.slice(ruleStart, blockStart).trim()
    const selectors = prelude.split(",").map((item) => item.trim())
    if (!selectors.includes(selector)) continue

    let depth = 0
    for (let index = blockStart; index < css.length; index++) {
      const char = css[index]
      if (char === "{") {
        depth++
        continue
      }
      if (char !== "}") continue
      depth--
      if (depth === 0) {
        bodies.push(css.slice(blockStart + 1, index))
        searchIndex = index + 1
        break
      }
    }
  }

  return bodies
}

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

async function runAppBuild(outDir: string) {
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", "build", "--outDir", outDir, "--emptyOutDir"],
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
      const [css, index, assets, javascript] = await Promise.all([
        readBuiltCss(outDir),
        readBuiltIndex(outDir),
        readBuiltAssets(outDir),
        readBuiltJavaScript(outDir),
      ])

      for (const contract of rootRuleContracts) {
        expectRootRule(css, contract)
      }

      const expandedCompactionBodies = collectRootRuleBodies(
        css,
        "[data-component=compaction-card] [data-slot=collapsible-content][data-expanded]",
      )
      expect(expandedCompactionBodies.length, "Missing expanded compaction card CSS rule").toBeGreaterThan(0)
      expect(expandedCompactionBodies.join(";")).not.toContain(" both")

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
      expect((await stat(path.join(outDir, "assets", markdownChunk!))).size).toBeLessThan(200_000)
    } finally {
      await rm(outDir, { recursive: true, force: true })
    }
  }, 60_000)
})
