import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
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
  directory = await mkdtemp(path.join(import.meta.dir, ".mobile-workspace-fixture-"))
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
    import { DialogProvider, useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
    import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
    import { createSignal, Show } from "solid-js"
    import { MobileWorkspaceDialog } from ${JSON.stringify(`/@fs/${source}/components/workspace/mobile-workspace-dialog.tsx`)}
    import { messages as en } from ${JSON.stringify(`/@fs/${source}/locales/en/messages.po`)}
    import "@ericsanchezok/synergy-ui/styles"
    import ${JSON.stringify(`/@fs/${source}/index.css`)}
    const i18n = setupI18n({ locale: "en", messages: { en } })
    window.closeCount = 0
    function Fixture() {
      const dialog = useDialog()
      const [open, setOpen] = createSignal(false)
      window.unmount = () => setOpen(false)
      window.mountWorkspace = () => setOpen(true)
      return <>
        <button onClick={() => setOpen(true)}>Open mobile workspace</button><button>Background action</button>
        <button onClick={() => dialog.push(() => <Dialog title="Restore preview"><button>Confirm restoration</button></Dialog>)}>Preview restore</button>
        <Show when={open()}><MobileWorkspaceDialog onClose={() => { window.closeCount++; setOpen(false) }}>
          <button>Workspace action</button><input aria-label="Workspace input" />
        </MobileWorkspaceDialog></Show>
      </>
    }
    render(() => <I18nProvider i18n={i18n}><DialogProvider><Fixture /></DialogProvider></I18nProvider>, document.querySelector("#root"))
  `,
  )
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, "vite-cache"),
    plugins: [solidPlugin(), tailwindcss(), ...lingui()],
    resolve: { alias: { "@": source } },
    optimizeDeps: { noDiscovery: true, include: ["solid-js", "solid-js/web", "@lingui/core", "@lingui/solid"] },
    server: { host: "127.0.0.1", port: await fixturePort(), fs: { allow: [path.resolve(source, "../../..")] } },
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

interface MobileWindow extends Window {
  closeCount: number
  unmount(): void
  mountWorkspace(): void
}

test("switching to mobile preserves the active confirmation before presenting the workspace", async () => {
  await page.goto(baseUrl)
  await page.getByRole("button", { name: "Preview restore" }).click()
  await page.getByRole("button", { name: "Confirm restoration" }).waitFor()
  await page.evaluate(() => (window as unknown as MobileWindow).mountWorkspace())
  expect(await page.getByRole("dialog", { name: "Workspace", exact: true }).count()).toBe(0)
  expect(await page.getByRole("button", { name: "Confirm restoration" }).isVisible()).toBe(true)
  await page.keyboard.press("Tab")
  expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]')?.textContent)).toContain(
    "Restore preview",
  )
  await page.keyboard.press("Escape")
  await page.getByRole("dialog", { name: "Workspace", exact: true }).waitFor()
  await page.keyboard.press("Escape")
  await page.getByRole("dialog").waitFor({ state: "detached" })
  expect(errors).toEqual([])
})

test("mobile workspace contains focus, fits the viewport and returns to its entry", async () => {
  errors.length = 0
  await page.goto(baseUrl)
  await page.getByRole("button", { name: "Open mobile workspace" }).click()
  await page.getByRole("dialog", { name: "Workspace", exact: true }).waitFor()
  await page.waitForFunction(() => !!document.activeElement?.closest('[role="dialog"]'))
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press(i < 4 ? "Tab" : "Shift+Tab")
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true)
  }
  expect(await page.getByRole("button", { name: "Background action" }).count()).toBe(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.waitForFunction(() => {
    const box = document.querySelector('[role="dialog"]')?.getBoundingClientRect()
    return box?.width === innerWidth && box.height === innerHeight
  })
  const box = (await page.getByRole("dialog").boundingBox())!
  expect(box.width).toBeCloseTo(375, 1)
  expect(box.height).toBeCloseTo(812, 1)
  await page.keyboard.press("Escape")
  await page.getByRole("dialog").waitFor({ state: "detached" })
  await page.waitForFunction(() => document.activeElement?.textContent === "Open mobile workspace")
  expect(await page.evaluate(() => (window as unknown as MobileWindow).closeCount)).toBe(1)
  expect(errors).toEqual([])
})

test("leaving the mobile presentation does not close the owning workspace", async () => {
  await page.goto(baseUrl)
  await page.getByRole("button", { name: "Open mobile workspace" }).click()
  await page.getByRole("dialog").waitFor()
  await page.evaluate(() => (window as unknown as MobileWindow).unmount())
  await page.getByRole("dialog").waitFor({ state: "detached" })
  expect(await page.evaluate(() => (window as unknown as MobileWindow).closeCount)).toBe(0)
  expect(errors).toEqual([])
})

test("reduced motion removes expanded workspace and overlay animations", async () => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  try {
    await page.goto(baseUrl)
    await page.getByRole("button", { name: "Open mobile workspace" }).click()
    await page.getByRole("dialog").waitFor()
    const animation = await page.getByRole("dialog").evaluate((element) => {
      const style = getComputedStyle(element)
      return { name: style.animationName, transform: style.transform }
    })
    expect(animation).toEqual({ name: "none", transform: "none" })
    expect(
      await page
        .locator('[data-component="dialog-overlay"]')
        .evaluate((element) => getComputedStyle(element).animationName),
    ).toBe("none")
    await page.keyboard.press("Escape")
    await page.getByRole("dialog").waitFor({ state: "detached" })
    await page.waitForFunction(() => document.activeElement?.textContent === "Open mobile workspace")
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Open mobile workspace")
  } finally {
    await page.emulateMedia({ reducedMotion: "no-preference" })
  }
}, 20000)
