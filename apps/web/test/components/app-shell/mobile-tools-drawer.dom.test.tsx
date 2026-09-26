import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { lingui } from "@lingui/vite-plugin"

let browser: Browser
let page: Page
let server: ViteDevServer
let directory: string
let baseUrl: string
const errors: string[] = []
const source = path.resolve(import.meta.dir, "../../../src")

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".mobile-tools-fixture-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { setupI18n } from "@lingui/core"
    import { I18nProvider } from "@lingui/solid"
    import { DialogProvider } from "@ericsanchezok/synergy-ui/context/dialog"
    import { MobileToolsDrawer } from ${JSON.stringify(`/@fs/${source}/components/app-shell/mobile-tools-drawer.tsx`)}
    import { Router } from "@solidjs/router"
    import { setOpen } from "@/context/layout"
    import { messages as en } from ${JSON.stringify(`/@fs/${source}/locales/en/messages.po`)}
    import "@ericsanchezok/synergy-ui/styles"
    import ${JSON.stringify(`/@fs/${source}/index.css`)}
    const i18n = setupI18n({ locale: "en", messages: { en } })
    function Fixture() {
      return <><button onClick={() => setOpen(true)}>Open tools</button><button>Background action</button><MobileToolsDrawer /></>
    }

    render(() => <I18nProvider i18n={i18n}><Router root={() => <DialogProvider><Fixture /></DialogProvider>} /></I18nProvider>, document.querySelector("#root"))
  `,
  )
  await Bun.write(
    path.join(directory, "layout.ts"),
    `import {createSignal} from "solid-js"; const [open,setOpen]=createSignal(false); export {setOpen}; export const useLayout=()=>({rightSidebar:{opened:open,hide:()=>setOpen(false)}})`,
  )
  await Bun.write(
    path.join(directory, "settings.tsx"),
    `import {Dialog} from "@ericsanchezok/synergy-ui/dialog"; export const SettingsDialog=()=> <Dialog title="Settings fixture"><button>Settings action</button></Dialog>`,
  )
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, "vite-cache"),
    plugins: [solidPlugin(), tailwindcss(), ...lingui()],
    resolve: {
      alias: [
        { find: "@/context/layout", replacement: path.join(directory, "layout.ts") },
        { find: "@/components/settings", replacement: path.join(directory, "settings.tsx") },
        { find: "@", replacement: source },
      ],
    },
    optimizeDeps: { noDiscovery: true, include: ["solid-js", "solid-js/web", "@lingui/core", "@lingui/solid"] },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [path.resolve(source, "../../..")] } },
  })
  await server.listen()
  baseUrl = server.resolvedUrls!.local[0]!
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 375, height: 812 } })
  page.on("pageerror", (error) => errors.push(error.message))
}, 60000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("tools drawer isolates background focus, closes one layer and returns to its entry", async () => {
  await page.goto(baseUrl)
  await page.getByRole("button", { name: "Open tools" }).click()
  await page.getByRole("dialog", { name: "Tools", exact: true }).waitFor({ timeout: 5000 })
  await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.getBoundingClientRect().y === 0)
  const bounds = await page.getByRole("dialog", { name: "Tools", exact: true }).boundingBox()
  expect(bounds?.y).toBe(0)
  expect(bounds?.height).toBe(812)
  expect(Math.round((bounds?.x ?? 0) + (bounds?.width ?? 0))).toBe(375)
  expect(await page.getByRole("button", { name: "Background action" }).count()).toBe(0)
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press(i < 5 ? "Tab" : "Shift+Tab")
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true)
  }
  expect(await page.getByRole("button", { name: "Kanban", exact: true }).count()).toBe(1)
  await page.getByRole("button", { name: "Close tools", exact: true }).click()
  await page.getByRole("dialog").waitFor({ state: "detached" })
  await page.waitForFunction(() => document.activeElement?.textContent === "Open tools")
  expect(errors).toEqual([])
})

test("Escape closes settings before tools and restores each entry", async () => {
  await page.goto(baseUrl)
  await page.getByRole("button", { name: "Open tools" }).click()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await page.getByRole("dialog", { name: "Settings fixture" }).waitFor()
  expect(await page.getByRole("dialog", { name: "Tools", exact: true }).count()).toBe(0)
  await page.keyboard.press("Escape")
  await page.getByRole("dialog", { name: "Tools", exact: true }).waitFor()
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Settings")
  await page.keyboard.press("Escape")
  await page.getByRole("dialog").waitFor({ state: "detached" })
  await page.waitForFunction(() => document.activeElement?.textContent === "Open tools")
})

test("widening the window closes the mobile modal and restores background access", async () => {
  await page.goto(baseUrl)
  await page.getByRole("button", { name: "Open tools" }).click()
  await page.getByRole("dialog", { name: "Tools", exact: true }).waitFor()
  await page.setViewportSize({ width: 1024, height: 812 })
  await page.getByRole("dialog").waitFor({ state: "detached" })
  expect(await page.getByRole("button", { name: "Background action" }).count()).toBe(1)
  await page.setViewportSize({ width: 375, height: 812 })
})
