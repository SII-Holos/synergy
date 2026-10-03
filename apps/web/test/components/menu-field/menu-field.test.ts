import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"

setDefaultTimeout(30000)

let browser: Browser
let page: Page
let server: ViteDevServer
let fixtureDirectory: string

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".menu-field-fixture-"))
  const menuFieldPath = path.resolve(import.meta.dir, "../../../../../packages/ui/src/components/menu-field.tsx")
  const declarativeFormPath = path.resolve(
    import.meta.dir,
    "../../../src/plugin/components/declarative-settings-form.tsx",
  )

  await Promise.all([
    Bun.write(
      path.join(fixtureDirectory, "index.html"),
      '<!doctype html><html style="overflow:hidden"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>.w-full{width:100%}</style></head><body><div id="root" style="padding:24px"></div><script type="module" src="/main.tsx"></script></body></html>',
    ),
    Bun.write(
      path.join(fixtureDirectory, "main.tsx"),
      `
        import { createComponent, createSignal } from "solid-js"
        import { render } from "solid-js/web"
        import { MenuField } from ${JSON.stringify(`/@fs/${menuFieldPath}`)}
        import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
        import { DialogProvider, useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
        import { setupI18n } from "@lingui/core"
        import { I18nProvider } from "@lingui/solid"
        import { DeclarativeSettingsForm } from ${JSON.stringify(`/@fs/${declarativeFormPath}`)}
        import "@ericsanchezok/synergy-ui/styles"
        function App() {
          const [value, setValue] = createSignal("a")
          const [changes, setChanges] = createSignal<string[]>([])
          window.__changes = () => changes()
          return createComponent(MenuField, {
            get value() {
              return value()
            },
            ariaLabel: "Pick an option",
            options: [
              { value: "a", label: "Alpha" },
              { value: "b", label: "Beta" },
              { value: "c", label: "Gamma" },
            ],
            onChange: (v: string) => {
              setValue(v)
              setChanges((prev) => [...prev, v])
            },
          })
        }

        function MultipleFixture() {
          const [values, setValues] = createSignal(["a"])
          return <><MenuField multiple value={values()} onChange={setValues} triggerLabel="Categories" ariaLabel="Categories" leading={close => <button class="menu-field-item" onClick={() => {setValues([]); close()}}>Clear categories</button>} options={[{value:"a",label:"Alpha"},{value:"b",label:"Beta"},{value:"locked",label:"Unavailable",disabled:true}]} /><output>{values().join(",")}</output></>
        }

        function PluginFixture() {
          const dialog = useDialog()
          const [values, setValues] = createSignal({delivery:"queued",note:"Retained field"})
          const open = () => dialog.show(() => <Dialog title="Plugin configuration"><DeclarativeSettingsForm schema={{properties:{delivery:{type:"string",title:"Delivery",enum:["queued","direct"]},note:{type:"string",title:"Note"}}}} values={values()} onChange={setValues} /></Dialog>)
          return <><button onClick={open}>Configure plugin</button><output>{JSON.stringify(values())}</output></>
        }

        function LongListFixture() {
          const longLabel = "A complete project name with a very long identifier " + "long-name-".repeat(14)
          const [value, setValue] = createSignal("item-29")
          return <MenuField ariaLabel="Project" value={value()} onChange={setValue} options={Array.from({length:30},(_,index)=>({value:"item-"+index,label:index===29 ? longLabel : "Project "+index}))}/>
        }

        const i18n = setupI18n({locale:"en",messages:{en:{}}})
        render(() => <I18nProvider i18n={i18n}><DialogProvider>{location.search.includes("plugin") ? <PluginFixture/> : location.search.includes("multiple") ? <MultipleFixture/> : location.search.includes("long") ? <LongListFixture/> : createComponent(App)}</DialogProvider></I18nProvider>, document.querySelector("#root"))
      `,
    ),
  ])

  server = await createServer({
    configFile: false,
    root: fixtureDirectory,
    cacheDir: path.join(fixtureDirectory, "cache"),
    optimizeDeps: { entries: [path.join(fixtureDirectory, "main.tsx")] },
    plugins: [solidPlugin()],
    resolve: { alias: { "@": path.resolve(import.meta.dir, "../../../src") } },
    server: {
      host: "127.0.0.1",
      port: await fixturePort(),
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
  page.setDefaultTimeout(5000)
}, 60000)

afterAll(async () => {
  await page?.close()
  await browser?.close()
  await server?.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

describe("MenuField interaction contract", () => {
  test("exposes listbox semantics, selects once, guards repeated picks, and supports keyboard", async () => {
    const trigger = page.getByRole("button", { name: /Pick an option/ })
    await trigger.waitFor()
    await expect(trigger.count()).resolves.toBe(1)
    expect(await trigger.getAttribute("aria-haspopup")).toBe("dialog")
    expect(await trigger.getAttribute("aria-expanded")).toBe("false")

    // 1. Listbox/option semantics with the current value announced.
    await trigger.click()
    await expect(page.getByRole("listbox").count()).resolves.toBe(1)
    await expect(page.getByRole("option").count()).resolves.toBe(3)
    const alpha = page.getByRole("option", { name: "Alpha" })
    const beta = page.getByRole("option", { name: "Beta" })
    await page.waitForFunction((element) => element === document.activeElement, await alpha.elementHandle())
    expect(await alpha.getAttribute("aria-selected")).toBe("true")
    expect(await beta.getAttribute("aria-selected")).toBe("false")
    expect(await trigger.getAttribute("aria-expanded")).toBe("true")
    expect(await alpha.locator('[data-slot="menu-field-indicator"]').count()).toBe(1)
    expect(await beta.locator('[data-slot="menu-field-indicator"]').count()).toBe(0)
    expect(await page.getByRole("listbox").getAttribute("aria-label")).toBe("Pick an option")
    const surface = page.locator(".menu-field-surface")
    const style = await surface.evaluate((element) => {
      const css = getComputedStyle(element)
      return {
        radius: css.borderRadius,
        shadow: css.boxShadow,
        font: getComputedStyle(element.querySelector('[role="option"]')!).fontSize,
      }
    })
    expect(style.radius).toBe("12px")
    expect(style.shadow).not.toBe("none")
    expect(style.font).toBe("13px")
    const triggerBounds = await trigger.boundingBox()
    const menuBounds = await surface.boundingBox()
    expect(Math.abs(menuBounds!.x - triggerBounds!.x)).toBeLessThanOrEqual(1)

    // 2. Selecting an option reports the change once.
    await beta.click()
    expect(await page.evaluate(() => (window as unknown as { __changes: () => string[] }).__changes())).toEqual(["b"])
    expect((await trigger.textContent()) ?? "").toContain("Beta")

    // 3. Pressing the active option again does not fire onChange.
    await trigger.click()
    await beta.click()
    expect(await page.evaluate(() => (window as unknown as { __changes: () => string[] }).__changes())).toEqual(["b"])

    // 4. Arrow-key navigation and typeahead work in the listbox.
    await trigger.click()
    const listbox = page.getByRole("listbox")
    await expect(listbox.count()).resolves.toBe(1)
    await page.waitForFunction((element) => element === document.activeElement, await beta.elementHandle())
    await alpha.focus()
    await page.keyboard.press("ArrowDown")
    expect(await beta.getAttribute("data-highlighted")).toBe("")
    await page.keyboard.press("g") // typeahead to Gamma
    const gamma = page.getByRole("option", { name: "Gamma" })
    expect(await gamma.getAttribute("data-highlighted")).toBe("")
    await page.keyboard.press("Enter")
    const changes = await page.evaluate(() => (window as unknown as { __changes: () => string[] }).__changes())
    expect(changes.at(-1)).toBe("c")
    expect((await trigger.textContent()) ?? "").toContain("Gamma")

    // Browsing choices does not submit; Escape returns to the single trigger.
    await page.getByRole("listbox").waitFor({ state: "detached" })
    await trigger.press("ArrowUp")
    await listbox.waitFor()
    await page.waitForFunction((element) => element === document.activeElement, await gamma.elementHandle())
    await page.keyboard.press("Home")
    expect(await alpha.getAttribute("data-highlighted")).toBe("")
    expect(await gamma.getAttribute("aria-selected")).toBe("true")
    await page.keyboard.press("Escape")
    await listbox.waitFor({ state: "detached" })
    await page.waitForFunction((element) => element === document.activeElement, await trigger.elementHandle())
    expect(await trigger.getAttribute("aria-expanded")).toBe("false")

    // The same mounted selector follows theme and motion changes and fits a short phone viewport.
    await page.setViewportSize({ width: 375, height: 240 })
    await trigger.press("Space")
    await listbox.waitFor()
    const colors: string[] = []
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme })
      await beta.hover()
      const appearance = await surface.evaluate((element) => {
        const css = getComputedStyle(element)
        const box = element.getBoundingClientRect()
        const row = element.querySelector('[role="option"]')!
        return {
          background: css.backgroundColor,
          height: row.getBoundingClientRect().height,
          fits: box.x >= 0 && box.right <= innerWidth && box.y >= 0 && box.bottom <= innerHeight,
        }
      })
      colors.push(appearance.background)
      expect(appearance.background).not.toBe("rgba(0, 0, 0, 0)")
      expect(appearance.height).toBeGreaterThanOrEqual(44)
      expect(appearance.fits).toBe(true)
      expect(await gamma.locator('[data-slot="menu-field-indicator"]').count()).toBe(1)
      expect(await beta.locator('[data-slot="menu-field-indicator"]').count()).toBe(0)
    }
    expect(colors[0]).not.toBe(colors[1])
    await page.emulateMedia({ reducedMotion: "reduce" })
    expect(await trigger.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe("0s")
    expect(await surface.evaluate((element) => getComputedStyle(element).animationName)).toBe("none")
    await page.keyboard.press("Escape")
    await listbox.waitFor({ state: "detached" })
  })
  test("multiple choices retain selection through Escape and disabled options are skipped", async () => {
    await page.setViewportSize({ width: 375, height: 640 })
    await page.goto(server.resolvedUrls!.local[0]! + "?multiple")
    const trigger = page.getByRole("button", { name: "Categories: Categories", exact: true })
    await trigger.press("Enter")
    const list = page.getByRole("listbox", { name: "Categories", exact: true })
    await list.waitFor()
    await page.waitForFunction(
      (element) => element === document.activeElement,
      await page.getByRole("option", { name: "Alpha", exact: true }).elementHandle(),
    )
    expect(
      await page
        .getByRole("option", { name: "Alpha", exact: true })
        .evaluate((element) => element === document.activeElement),
    ).toBe(true)
    await page.getByRole("option", { name: "Beta", exact: true }).click()
    expect(await list.isVisible()).toBe(true)
    expect(await page.locator('[data-slot="menu-field-indicator"]').count()).toBe(2)
    await page.getByRole("option", { name: "Alpha", exact: true }).focus()
    await page.keyboard.press("End")
    expect(await page.getByRole("option", { name: "Beta", exact: true }).getAttribute("data-highlighted")).toBe("")
    expect(await page.getByRole("option", { name: "Unavailable", exact: true }).getAttribute("aria-disabled")).toBe(
      "true",
    )
    await page.keyboard.press("Escape")
    await list.waitFor({ state: "detached" })
    await page.waitForFunction((element) => element === document.activeElement, await trigger.elementHandle())
    expect(await page.locator("output").textContent()).toBe("a,b")
    await trigger.press("Space")
    expect(await page.locator('[data-slot="menu-field-indicator"]').count()).toBe(2)
    await page.keyboard.press("Escape")
    await list.waitFor({ state: "detached" })
  })

  test("plugin enum fields share the menu without dismissing the parent or losing other values", async () => {
    await page.setViewportSize({ width: 375, height: 640 })
    await page.goto(server.resolvedUrls!.local[0]! + "?plugin")
    await page.emulateMedia({ reducedMotion: "reduce" })
    const opener = page.getByRole("button", { name: "Configure plugin", exact: true })
    await opener.click()
    const dialog = page.getByRole("dialog", { name: "Plugin configuration", exact: true })
    const trigger = dialog.getByRole("button", { name: "Delivery: queued", exact: true })
    expect(await trigger.getAttribute("id")).toBe("plugin-setting-delivery")
    await trigger.press("Enter")
    const direct = page.getByRole("option", { name: "direct", exact: true })
    await direct.waitFor()
    await page.waitForFunction(
      (element) => element === document.activeElement,
      await page.getByRole("option", { name: "queued", exact: true }).elementHandle(),
    )
    const fieldBounds = await trigger.boundingBox()
    const menuBounds = await page.locator(".menu-field-surface").boundingBox()
    expect(menuBounds!.width).toBeGreaterThanOrEqual(fieldBounds!.width - 1)
    await direct.press("ArrowUp")
    await page.keyboard.press("Escape")
    await page.getByRole("listbox").waitFor({ state: "detached" })
    await page.waitForFunction((element) => element === document.activeElement, await trigger.elementHandle())
    expect(await dialog.isVisible()).toBe(true)
    expect(await dialog.getByLabel("Note", { exact: true }).inputValue()).toBe("Retained field")
    await trigger.press("Space")
    await direct.press("Enter")
    await page.getByRole("listbox").waitFor({ state: "detached" })
    expect(JSON.parse((await page.locator("output").textContent())!).delivery).toBe("direct")
    const changed = dialog.getByRole("button", { name: "Delivery: direct", exact: true })
    await changed.waitFor({ state: "visible" })
    await page.waitForFunction((element) => element === document.activeElement, await changed.elementHandle())
    await page.keyboard.press("Escape")
    await dialog.waitFor({ state: "detached" })
    await page.waitForFunction((element) => element === document.activeElement, await opener.elementHandle())
    expect(JSON.parse((await page.locator("output").textContent())!)).toEqual({
      delivery: "direct",
      note: "Retained field",
    })
  })

  test("long labels wrap and keyboard navigation scrolls a bounded list in short viewports", async () => {
    await page.setViewportSize({ width: 375, height: 320 })
    await page.goto(server.resolvedUrls!.local[0]! + "?long")
    const trigger = page.getByRole("button", { name: /^Project: A complete/ })
    await trigger.press("ArrowDown")
    const long = page.getByRole("option", { name: /^A complete project name/ })
    await long.waitFor()
    await page.waitForFunction((element) => element === document.activeElement, await long.elementHandle())
    await page.waitForFunction(() => document.querySelector(".menu-field-surface")!.scrollTop > 0)
    const geometry = await page.locator(".menu-field-surface").evaluate((surface) => {
      const bounds = surface.getBoundingClientRect()
      const label = surface.querySelector('[aria-selected="true"] .menu-field-item-label')!
      return {
        fits: bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight,
        readable: label.scrollWidth <= label.clientWidth,
        wraps: label.getBoundingClientRect().height > 18,
        scrolls: surface.scrollHeight > surface.clientHeight,
        position: surface.scrollTop,
      }
    })
    expect(geometry.fits).toBe(true)
    expect(geometry.readable).toBe(true)
    expect(geometry.wraps).toBe(true)
    expect(geometry.scrolls).toBe(true)
    expect(geometry.position).toBeGreaterThan(0)
    expect(await long.evaluate((element) => element === document.activeElement)).toBe(true)
    await page.keyboard.press("Home")
    expect(
      await page
        .getByRole("option", { name: "Project 0", exact: true })
        .evaluate((element) => element === document.activeElement),
    ).toBe(true)
    await page.keyboard.press("Escape")
    await page.getByRole("listbox").waitFor({ state: "detached" })
    await page.waitForFunction((element) => element === document.activeElement, await trigger.elementHandle())
  })
})
