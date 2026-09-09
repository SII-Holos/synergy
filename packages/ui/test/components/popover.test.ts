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
    import { Popover } from ${JSON.stringify(`/@fs/${components}/popover.tsx`)}
    import { Tooltip } from ${JSON.stringify(`/@fs/${components}/tooltip.tsx`)}
    import { pluginComponents } from ${JSON.stringify(`/@fs/${components}/plugin-components.tsx`)}
    function Fixture() {
      const [open, setOpen] = createSignal(false)
      const [count, setCount] = createSignal(0)
      return <>
        <Popover open={open()} onOpenChange={setOpen}
          trigger={<Tooltip value="Session actions" inactive={count() > 0}>
            <button aria-label="Session actions">Actions</button>
          </Tooltip>}>
          <button onClick={() => { setCount(count() + 1); setOpen(false) }}>Rename</button>
        </Popover>
        <output>{count()}</output>
        <Popover triggerAs={triggerProps => <Tooltip value="Native actions">
          <button {...triggerProps} aria-label="Native actions">More</button>
        </Tooltip>}>
          <button>Export session</button>
        </Popover>
        <pluginComponents.Popover title="Plugin details"
          trigger={triggerProps => <button {...triggerProps}>Plugin actions</button>}>
          <button>Plugin action</button>
        </pluginComponents.Popover>
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
  await page.getByRole("button", { name: "Plugin actions", exact: true }).waitFor()
})

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (fixture) await rm(fixture, { recursive: true, force: true })
})

test("reactive Tooltip JSX opens a popover and remains usable after an action", async () => {
  const trigger = page.locator('button[aria-label="Session actions"]')
  const rename = page.getByRole("button", { name: "Rename", exact: true })
  await trigger.click()
  await rename.waitFor({ state: "visible", timeout: 3000 })
  await rename.click()
  expect(await page.locator("output").textContent()).toBe("1")
  await rename.waitFor({ state: "detached" })
  await trigger.click()
  await rename.waitFor({ state: "visible" })
  await page.keyboard.press("Escape")
  await rename.waitFor({ state: "detached" })
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-slot") === "popover-trigger")
  expect(errors).toEqual([])
})

for (const key of ["Enter", "Space"]) {
  test(`native trigger opens with ${key}, closes with Escape, and restores focus`, async () => {
    const trigger = page.getByRole("button", { name: "Native actions", exact: true })
    const action = page.getByRole("button", { name: "Export session", exact: true })
    await trigger.focus()
    expect(await trigger.getAttribute("aria-expanded")).toBe("false")
    await page.keyboard.press(key)
    await action.waitFor({ state: "visible" })
    await page.waitForFunction(() =>
      document.querySelector('[data-component="popover-content"]')?.contains(document.activeElement),
    )
    expect(await trigger.getAttribute("aria-expanded")).toBe("true")
    await page.keyboard.press("Escape")
    await action.waitFor({ state: "detached" })
    await page.waitForFunction((element) => element === document.activeElement, await trigger.elementHandle())
    expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true)
    expect(await trigger.getAttribute("aria-expanded")).toBe("false")
    expect(errors).toEqual([])
  })
}

test("public plugin component triggers retain pointer and focus behavior", async () => {
  const trigger = page.getByRole("button", { name: "Plugin actions", exact: true })
  const action = page.getByRole("button", { name: "Plugin action", exact: true })
  await trigger.click()
  await action.waitFor({ state: "visible" })
  await page.waitForFunction(() =>
    document.querySelector('[data-component="popover-content"]')?.contains(document.activeElement),
  )
  await page.keyboard.press("Escape")
  await action.waitFor({ state: "detached" })
  await page.waitForFunction((element) => element === document.activeElement, await trigger.elementHandle())
  expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true)
  expect(errors).toEqual([])
})
