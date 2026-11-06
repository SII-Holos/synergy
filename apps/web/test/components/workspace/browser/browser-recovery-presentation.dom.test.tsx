import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../../../support/browser-fixture"

const source = path.resolve(import.meta.dir, "../../../../src")
// Screenshots are opt-in: the assertions below are the contract, and writing
// images on every run would add unreviewed artifacts to each test run.
const shots = process.env.SYNERGY_BROWSER_RECOVERY_SHOTS
  ? path.resolve(import.meta.dir, "../../../../../../.artifacts/verify-browser-recovery")
  : undefined

async function capture(page: Page, name: string) {
  if (shots) await page.screenshot({ path: path.join(shots, name) })
}

let browser: Browser
let fixture: BrowserFixture
let directory: string

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".browser-recovery-presentation-"))
  await Promise.all([
    Bun.write(
      path.join(directory, "index.html"),
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
       <body style="margin:0">
         <div id="root" style="height:100dvh">
           <div class="synergy-workbench-canvas" style="height:100%">
             <div class="browser-workspace" style="height:100%">
               <div id="host" style="height:100%"></div>
             </div>
           </div>
         </div>
         <script type="module" src="/main.tsx"></script>
       </body></html>`,
    ),
    Bun.write(path.join(directory, "platform.ts"), `export const usePlatform = () => ({ browserNative: {} })`),
    Bun.write(path.join(directory, "page-dialog.tsx"), `export function BrowserPageDialog() { return null }`),
    Bun.write(
      path.join(directory, "native-surface.tsx"),
      `export function NativeBrowserSurface() { return <div data-testid="native-surface" /> }`,
    ),
    Bun.write(
      path.join(directory, "main.tsx"),
      `
        import { createComponent } from "solid-js"
        import { render } from "solid-js/web"
        import { setupI18n } from "@lingui/core"
        import { I18nProvider } from "@lingui/solid"
        import { BrowserStoreProvider, createBrowserStore } from ${JSON.stringify(`/@fs/${source}/components/workspace/browser/browser-store.tsx`)}
        import { BrowserSurface } from ${JSON.stringify(`/@fs/${source}/components/workspace/browser/browser-surface.tsx`)}
        import { browser as B } from "@/locales/messages"
        import { fontStyles } from ${JSON.stringify(`/@fs/${path.resolve(source, "../../../packages/ui/src/fonts.ts")}`)}
        import "@ericsanchezok/synergy-ui/styles"
        import ${JSON.stringify(`/@fs/${source}/index.css`)}

        const fontFace = document.createElement("style")
        fontFace.textContent = fontStyles()
        document.head.append(fontFace)

        const page = { id: "page-1", title: "Example", url: "https://github.com/example/repository", isLoading: false, lastActiveAt: null }
        const catalog = createBrowserStore()
        const store = catalog.forPage(() => page.id, () => {})
        catalog.replacePages([{ ...page, profileId: "personal", status: "active" }])
        store.setSession("connectionStatus", "connected")

        const messages = Object.fromEntries(Object.values(B).map((descriptor) => [descriptor.id, descriptor.message]))
        const i18n = setupI18n({ locale: "en" })
        i18n.loadAndActivate({ locale: "en", messages })

        const apply = {
          recovering: () => { catalog.replacePages([{ ...page, profileId: "personal", status: "active" }]); store.setHostStatus(page.id, "restarting") },
          failed: () => { catalog.replacePages([{ ...page, profileId: "personal", status: "active" }]); store.setHostStatus(page.id, "failed") },
          suspended: () => { catalog.replacePages([{ ...page, profileId: "personal", status: "suspended" }]); store.setHostStatus(page.id, "ready") },
          detached: () => { catalog.replacePages([{ ...page, profileId: "personal", status: "active" }]); store.setHostStatus(page.id, "detached") },
        }
        ;(window as any).setRecoveryState = (name: string) => apply[name as keyof typeof apply]()
        apply.suspended()

        render(
          () => createComponent(I18nProvider, {
            i18n,
            get children() {
              return createComponent(BrowserStoreProvider, {
                store,
                get children() {
                  return createComponent(BrowserSurface, {
                    route: { mode: "scope", path_directory: "home", scopeID: "home" },
                    ownerKey: "owner",
                    clientPresentation: "native",
                    onRetryNative: () => {},
                  })
                },
              })
            },
          }),
          document.getElementById("host")!,
        )
      `,
    ),
  ])

  fixture = await createBrowserFixture({
    root: directory,
    styled: true,
    localized: false,
    aliases: [
      { find: "@/context/platform", replacement: path.join(directory, "platform.ts") },
      { find: /^\.\/page-dialog$/, replacement: path.join(directory, "page-dialog.tsx") },
      { find: /^\.\/native-browser-surface$/, replacement: path.join(directory, "native-surface.tsx") },
      { find: "@", replacement: source },
    ],
  })
  browser = await chromium.launch({ headless: true })
  if (shots) await mkdir(shots, { recursive: true })
}, 180_000)

afterAll(async () => {
  await browser?.close()
  await fixture?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

function ratio(foreground: string, background: string) {
  const parse = (value: string) => {
    const [r, g, b] = value
      .match(/[\d.]+/g)!
      .slice(0, 3)
      .map(Number)
    const channel = (v: number) => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!)
  }
  const [lighter, darker] = [parse(foreground), parse(background)].sort((a, b) => b - a)
  return (lighter! + 0.05) / (darker! + 0.05)
}

async function measure(page: Page) {
  return page.locator(".browser-empty-state").evaluate((element) => {
    const mark = element.querySelector(".browser-empty-mark") as HTMLElement
    const title = element.querySelector(".browser-empty-title") as HTMLElement
    const button = element.querySelector('[data-component="button"]') as HTMLElement | null
    const canvas = element.closest(".synergy-workbench-canvas") as HTMLElement
    const style = (node: HTMLElement) => getComputedStyle(node)
    return {
      text: [...element.children].map((child) => child.textContent?.trim() ?? "").filter(Boolean),
      buttonCount: element.querySelectorAll('[data-component="button"]').length,
      mark: {
        width: style(mark).width,
        height: style(mark).height,
        radius: style(mark).borderRadius,
        background: style(mark).backgroundColor,
        color: style(mark).color,
        border: `${style(mark).borderTopWidth} ${style(mark).borderTopStyle} ${style(mark).borderTopColor}`,
        siteMark: mark.querySelector('[data-component="site-icon"]') !== null,
      },
      title: {
        size: style(title).fontSize,
        weight: style(title).fontWeight,
        color: style(title).color,
        family: style(title).fontFamily,
      },
      button: button
        ? {
            height: style(button).height,
            variant: button.dataset.variant,
            background: style(button).backgroundColor,
            color: style(button).color,
          }
        : null,
      canvas: style(canvas).backgroundColor,
    }
  })
}

for (const scheme of ["light", "dark"] as const) {
  describe(`${scheme} appearance`, () => {
    test("a whole-surface state is one mark, one name and one large action at AA contrast", async () => {
      const page = await browser.newPage({ viewport: { width: 900, height: 560 }, colorScheme: scheme })
      await page.goto(fixture.url)
      await page.waitForSelector(".browser-empty-title")

      await page.evaluate(() => (window as any).setRecoveryState("suspended"))
      const suspended = await measure(page)
      expect(suspended.text).toEqual(["Page suspended", "Resume page"])
      expect(suspended.buttonCount).toBe(1)
      expect(suspended.mark).toMatchObject({ width: "52px", height: "52px", radius: "10px" })
      expect(suspended.title).toMatchObject({ size: "16px", weight: "500", family: expect.stringContaining("Inter") })
      expect(suspended.button).toMatchObject({ height: "40px", variant: "primary" })
      // The mark names the page's own site, so the state never needs a sentence
      // explaining which page is coming back.
      expect(suspended.mark.siteMark).toBe(true)
      await capture(page, `${scheme}-suspended.png`)

      await page.evaluate(() => (window as any).setRecoveryState("failed"))
      const failed = await measure(page)
      expect(failed.text).toEqual(["Native browser recovery failed", "Retry"])
      expect(failed.buttonCount).toBe(1)
      await capture(page, `${scheme}-failed.png`)

      await page.evaluate(() => (window as any).setRecoveryState("recovering"))
      const recovering = await measure(page)
      expect(recovering.text).toEqual(["Recovering the native browser…"])
      expect(recovering.buttonCount).toBe(0)
      await capture(page, `${scheme}-recovering.png`)

      await page.evaluate(() => (window as any).setRecoveryState("detached"))
      const detached = await measure(page)
      expect(detached.text).toEqual(["Browser ready", "Retry"])
      expect(detached.buttonCount).toBe(1)
      await capture(page, `${scheme}-detached.png`)

      expect(ratio(suspended.title.color, suspended.canvas)).toBeGreaterThanOrEqual(4.5)
      expect(ratio(suspended.button!.color, suspended.button!.background)).toBeGreaterThanOrEqual(4.5)
      expect(ratio(detached.button!.color, detached.button!.background)).toBeGreaterThanOrEqual(4.5)
      // The mark must be separable from the canvas in both appearances; a
      // decorative halo is not a substitute for a real boundary.
      expect(suspended.mark.border).toMatch(/^1px solid rgba?\(/)
      expect(ratio(suspended.mark.color, suspended.mark.background)).toBeGreaterThanOrEqual(3)

      const surface = await page.locator(".browser-empty-state").innerText()
      expect(surface).not.toContain("connected")
      await page.close()
    }, 60_000)
  })
}
