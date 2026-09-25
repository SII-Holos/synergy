import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"

let browser: Browser
let page: Page
let server: ViteDevServer
let fixture: string
const errors: string[] = []

beforeAll(async () => {
  fixture = await mkdtemp(path.join(import.meta.dir, ".popover-fixture-"))
  const components = path.resolve(import.meta.dir, "../../src/components")
  await Bun.write(
    path.join(fixture, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(fixture, "main.tsx"),
    `
    import { createSignal } from "solid-js"
    import { render } from "solid-js/web"
    import { ToolbarSelectorPopover } from ${JSON.stringify(`/@fs/${components}/toolbar-selector.tsx`)}
    import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
    import { SidebarSectionButton } from ${JSON.stringify(`/@fs/${components}/sidebar/sidebar-section-button.tsx`)}
    function Fixture() {
      const [expanded, setExpanded] = createSignal(false)
      return <>
        <button>Before toolbar</button>
        <ToolbarSelectorPopover title="Agent" triggerAs={props => <Tooltip value="Agent">
          <button {...props}>Agent</button></Tooltip>}>
          {close => <button onClick={close}>Choose agent</button>}
        </ToolbarSelectorPopover>
        <button>After toolbar</button>
        <SidebarSectionButton open={expanded()} onClick={() => setExpanded(!expanded())}>Projects</SidebarSectionButton>
      </>
    }
    render(() => <Fixture />, document.getElementById("root"))
  `,
  )
  server = await createServer({
    configFile: false,
    root: fixture,
    plugins: [solidPlugin()],
    cacheDir: path.join(fixture, ".vite"),
    optimizeDeps: { include: ["solid-js", "solid-js/web", "solid-js/jsx-runtime"], noDiscovery: true },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [path.resolve(import.meta.dir, "../../../..")] } },
  })
  await server.listen()
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(server.resolvedUrls!.local[0]!)
}, 60000)

beforeEach(async () => {
  errors.length = 0
  await page.goto(server.resolvedUrls!.local[0]!)
  await page.getByRole("button", { name: "Agent", exact: true }).waitFor()
})

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (fixture) await rm(fixture, { recursive: true, force: true })
})

test("toolbar has one Tab stop and restores the native trigger after Escape", async () => {
  const trigger = page.getByRole("button", { name: "Agent", exact: true })
  await page.getByRole("button", { name: "Before toolbar" }).focus()
  await page.keyboard.press("Tab")
  expect(await trigger.evaluate((el) => el === document.activeElement)).toBe(true)
  await page.keyboard.press("Tab")
  expect(
    await page.getByRole("button", { name: "After toolbar" }).evaluate((el) => el === document.activeElement),
  ).toBe(true)
  for (const key of ["Enter", "Space"]) {
    await trigger.focus()
    await page.keyboard.press(key)
    await page.getByRole("button", { name: "Choose agent" }).waitFor()
    expect(await trigger.getAttribute("aria-expanded")).toBe("true")
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "Choose agent" }).waitFor({ state: "detached" })
    await page.waitForFunction(() => document.activeElement?.textContent === "Agent")
  }
  expect(errors).toEqual([])
})

test("sidebar disclosure supports native Enter and Space and announces its state", async () => {
  const button = page.getByRole("button", { name: "Projects" })
  await button.focus()
  expect(await button.getAttribute("aria-expanded")).toBe("false")
  await page.keyboard.press("Enter")
  expect(await button.getAttribute("aria-expanded")).toBe("true")
  await page.keyboard.press("Space")
  expect(await button.getAttribute("aria-expanded")).toBe("false")
  expect(errors).toEqual([])
})
