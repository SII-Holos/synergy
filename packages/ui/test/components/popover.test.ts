import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
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
    import { setupI18n } from "@lingui/core"
    import { I18nProvider } from "@lingui/solid"
    import { Popover } from ${JSON.stringify(`/@fs/${components}/popover.tsx`)}
    import { Tooltip } from ${JSON.stringify(`/@fs/${components}/tooltip.tsx`)}
    import { MenuField } from ${JSON.stringify(`/@fs/${components}/menu-field.tsx`)}
    import { SettingRow } from ${JSON.stringify(`/@fs/${components}/setting-row.tsx`)}
    import { TextField } from ${JSON.stringify(`/@fs/${components}/text-field.tsx`)}
    import { Switch } from ${JSON.stringify(`/@fs/${components}/switch.tsx`)}
    import { pluginComponents } from ${JSON.stringify(`/@fs/${components}/plugin-components.tsx`)}
    function Fixture() {
      const [open, setOpen] = createSignal(false)
      const [count, setCount] = createSignal(0)
      const [projectOpen, setProjectOpen] = createSignal(false)
      const [menuLayer, setMenuLayer] = createSignal()
      const [sources, setSources] = createSignal(["en", "zh"])
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
        <Popover open={projectOpen()} onOpenChange={setProjectOpen}
          triggerAs={triggerProps => <Tooltip value={projectOpen() ? "" : "Choose project"}>
            <button {...triggerProps} aria-label="Choose project">Project</button>
          </Tooltip>}>
          <input aria-label="Search projects" autofocus />
        </Popover>
        <Popover triggerAs={props => <button {...props}>Advanced options</button>}>
          <MenuField ariaLabel="Language" value="en" onChange={() => {}} options={[{value:"en",label:"English"},{value:"zh",label:"Chinese"}]} popoverLayer={menuLayer()} />
          <div ref={setMenuLayer} />
        </Popover>
        <MenuField multiple ariaLabel="Sources" triggerLabel="Selected sources" value={sources()} onChange={setSources} options={[{value:"en",label:"English source"},{value:"zh",label:"Chinese source"}]} />
        <div data-selected-sources>{sources().join(",")}</div>
        <SettingRow title="Service endpoint" description="Use your speech service URL." trailing={<TextField value="invalid" validationState="invalid" error="Enter an HTTP URL." />} />
        <SettingRow title="Read answers aloud" description="Use your saved speech model." trailing={<Switch aria-label="Read answers aloud" hideLabel>Read answers aloud</Switch>} />
      </>
    }
    const i18n = setupI18n({ locale: "en", messages: { en: {} } })
    render(() => <I18nProvider i18n={i18n}><Fixture /></I18nProvider>, document.getElementById("root"))
  `,
  )
  server = await createServer({
    configFile: false,
    root: fixture,
    plugins: [solidPlugin()],
    cacheDir: path.join(fixture, ".vite"),
    optimizeDeps: {
      include: ["solid-js", "solid-js/web", "solid-js/jsx-runtime", "@lingui/core", "@lingui/solid"],
      noDiscovery: true,
    },
    server: {
      host: "127.0.0.1",
      port: await fixturePort(),
      fs: { allow: [path.resolve(import.meta.dir, "../../../..")] },
    },
  })
  await server.listen()
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
}, 60000)

beforeEach(async () => {
  errors.length = 0
  page = await browser.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(server.resolvedUrls!.local[0]!)
  await page
    .getByRole("button", { name: "Plugin actions", exact: true })
    .waitFor()
    .catch((error) => {
      throw new Error(JSON.stringify({ errors }), { cause: error })
    })
})

afterEach(async () => {
  await page?.close()
})

test("settings controls retain their names, descriptions and inline errors", async () => {
  const input = page.getByRole("textbox", { name: "Service endpoint", exact: true })
  expect(await input.getAttribute("aria-invalid")).toBe("true")
  const described = await input.evaluate((element) =>
    (element.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent)
      .join(" "),
  )
  expect(described).toContain("Use your speech service URL.")
  expect(described).toContain("Enter an HTTP URL.")
  const toggle = page.getByRole("switch", { name: "Read answers aloud", exact: true })
  await toggle.press("Space")
  expect(await toggle.isChecked()).toBe(true)
  expect(
    await toggle.evaluate((element) => document.getElementById(element.getAttribute("aria-describedby")!)?.textContent),
  ).toBe("Use your saved speech model.")
})

test("a menu in a custom layer releases focus before its parent closes", async () => {
  await page.getByRole("button", { name: "Advanced options", exact: true }).click()
  const trigger = page.getByRole("button", { name: "Language: English", exact: true })
  await trigger.click()
  await page.getByRole("option", { name: "Chinese", exact: true }).waitFor()
  await page.getByRole("option", { name: "Chinese", exact: true }).press("Escape")
  await page.getByRole("option", { name: "Chinese", exact: true }).waitFor({ state: "detached" })
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Language: English")
  expect(await trigger.isVisible()).toBe(true)
  await page.keyboard.press("Escape")
  await trigger.waitFor({ state: "detached" })
  expect(errors).toEqual([])
})

test("Escape from a focused multiple-choice option closes the menu without clearing values", async () => {
  const trigger = page.getByRole("button", { name: "Sources: Selected sources", exact: true })
  await trigger.click()
  await page.getByRole("option", { name: "Chinese source", exact: true }).press("Escape")
  await page.getByRole("option", { name: "Chinese source", exact: true }).waitFor({ state: "detached" })
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Sources: Selected sources")
  expect(await page.locator("[data-selected-sources]").textContent()).toBe("en,zh")
  expect(errors).toEqual([])
})

test("menu checkmarks follow single and multiple selection without changing accessible option names", async () => {
  await page.getByRole("button", { name: "Advanced options", exact: true }).click()
  await page.getByRole("button", { name: "Language: English", exact: true }).click()
  const english = page.getByRole("option", { name: "English", exact: true })
  expect(await english.locator(".menu-field-item-indicator").isVisible()).toBe(true)
  expect(
    await page.getByRole("option", { name: "Chinese", exact: true }).locator(".menu-field-item-indicator").count(),
  ).toBe(0)
  await english.press("Escape")
  await english.waitFor({ state: "detached" })
  await page.getByRole("button", { name: "Language: English", exact: true }).press("Escape")
  const trigger = page.getByRole("button", { name: "Sources: Selected sources", exact: true })
  await trigger.click()
  const first = page.getByRole("option", { name: "English source", exact: true })
  const second = page.getByRole("option", { name: "Chinese source", exact: true })
  expect(await page.locator(".menu-field-item-indicator").count()).toBe(2)
  await first.click()
  expect(await first.getAttribute("aria-selected")).toBe("false")
  expect(await first.locator(".menu-field-item-indicator").count()).toBe(0)
  expect(await second.locator(".menu-field-item-indicator").isVisible()).toBe(true)
  await second.press("Escape")
  expect(await page.locator("[data-selected-sources]").textContent()).toBe("zh")
  expect(errors).toEqual([])
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

test("suppressing a focused trigger tooltip preserves Escape and trigger identity", async () => {
  const trigger = page.getByRole("button", { name: "Choose project", exact: true })
  const original = await trigger.elementHandle()
  await trigger.focus()
  await page.getByRole("tooltip").waitFor()
  await trigger.click()
  await page.getByRole("textbox", { name: "Search projects" }).waitFor()
  expect(await trigger.evaluate((element, original) => element === original, original)).toBe(true)
  await page.waitForFunction(() => !document.querySelector('[data-component="tooltip"]'))
  await page.keyboard.press("Escape")
  await page.getByRole("textbox", { name: "Search projects" }).waitFor({ state: "detached", timeout: 3000 })
  await page.waitForFunction((element) => document.activeElement === element, original)
  expect(errors).toEqual([])
})
