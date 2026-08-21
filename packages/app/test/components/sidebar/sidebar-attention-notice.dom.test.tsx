import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"

let browser: Browser
let page: Page
let server: ViteDevServer
let fixtureDirectory: string

// The component's UI-module imports (Icon, Tooltip, Lingui, locale catalog)
// do not load under a minimal Vite fixture; route them to a hermetic stub.
// resolve.alias runs before Vite's core resolver.
const stubbed = [
  "@ericsanchezok/synergy-ui/icon",
  "@ericsanchezok/synergy-ui/semantic-icon",
  "@ericsanchezok/synergy-ui/tooltip",
  "@lingui/solid",
  "@/locales/messages",
]

function notice(progress: number, percentLabel: string) {
  return {
    id: "product-update",
    source: "product-update",
    priority: 400,
    tone: "active",
    title: { id: "t", message: "Downloading Synergy" },
    detail: { id: "d", message: `Downloading ${percentLabel}%` },
    actionLabel: null,
    action: null,
    progress,
    busy: false,
    iconToken: "product.update",
  }
}

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".sidebar-attention-fixture-"))
  const componentPath = path.resolve(import.meta.dir, "../../../src/components/sidebar/sidebar-attention-notice.tsx")
  const stubPath = path.join(fixtureDirectory, "stubs.tsx")

  await Promise.all([
    Bun.write(
      path.join(fixtureDirectory, "index.html"),
      '<div id="root"></div><script type="module" src="/main.tsx"></script>',
    ),
    Bun.write(
      stubPath,
      `
        export const Icon = () => null
        export const getSemanticIcon = (token: string) => token
        export const Tooltip = (props: any) => props.children
        export const useLingui = () => ({
          _: (d: { id: string; message?: string }) => d.message ?? d.id,
          i18n: {},
        })
        export const sidebar = { busy: { id: "app.sidebar.busy", message: "Busy" } }
      `,
    ),
    Bun.write(
      path.join(fixtureDirectory, "main.tsx"),
      `
        import { createComponent, createSignal } from "solid-js"
        import { render } from "solid-js/web"
        import { SidebarAttentionNotice } from ${JSON.stringify(`/@fs/${componentPath}`)}

        function App() {
          const [notice, setNotice] = createSignal<any>(null)
          ;(window as any).__setNotice = setNotice
          return createComponent(SidebarAttentionNotice, {
            get notice() {
              return notice()
            },
            get isExpanded() {
              return true
            },
            onAction: () => {},
          })
        }

        render(() => createComponent(App, {}), document.querySelector("#root")!)
      `,
    ),
  ])

  server = await createServer({
    configFile: false,
    root: fixtureDirectory,
    plugins: [solidPlugin()],
    resolve: { alias: stubbed.map((find) => ({ find, replacement: stubPath })) },
    server: {
      host: "127.0.0.1",
      port: 5210,
      strictPort: true,
      fs: { allow: [path.resolve(import.meta.dir, "../../../..")] },
    },
  })
  await server.listen()

  const url = server.resolvedUrls?.local[0]
  if (!url) throw new Error("Expected Vite test server URL")

  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  await page.goto(url)
})

afterAll(async () => {
  await page?.close()
  await browser?.close()
  await server?.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

describe("sidebar attention notice progress reactivity", () => {
  test("re-renders progress when the notice object updates", async () => {
    // The card mounts once the notice becomes truthy (downloading at 0%).
    await page.evaluate(
      (n) => (window as unknown as { __setNotice: (v: unknown) => void }).__setNotice(n),
      notice(0, "0"),
    )
    await expect(page.locator(".sb-attention-notice").count()).resolves.toBe(1)
    const initialStyle = await page.locator(".sb-attention-progress span").getAttribute("style")
    expect(initialStyle).toContain("0%")
    expect(await page.locator(".sb-attention-detail").textContent()).toContain("Downloading 0%")

    // A later progress event produces a new notice object (same phase); the
    // keyed Show must re-run the child so the card tracks 87%.
    await page.evaluate(
      (n) => (window as unknown as { __setNotice: (v: unknown) => void }).__setNotice(n),
      notice(87, "87"),
    )
    const updatedStyle = await page.locator(".sb-attention-progress span").getAttribute("style")
    expect(updatedStyle).toContain("87%")
    expect(await page.locator(".sb-attention-detail").textContent()).toContain("Downloading 87%")
  })
})
