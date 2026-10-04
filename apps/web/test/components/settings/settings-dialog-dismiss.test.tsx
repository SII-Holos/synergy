import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"

let browser: Browser
let page: Page
let server: ViteDevServer
let fixtureDirectory: string
let fixtureUrl: string
const errors: string[] = []

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".settings-dialog-dismiss-fixture-"))
  const componentPath = path.resolve(import.meta.dir, "../../../src/components/settings/settings-dialog-frame.tsx")

  await Promise.all([
    Bun.write(
      path.join(fixtureDirectory, "index.html"),
      '<div id="root"></div><script type="module" src="/main.tsx"></script>',
    ),
    Bun.write(
      path.join(fixtureDirectory, "main.tsx"),
      `
        import { setupI18n } from "@lingui/core"
        import { I18nProvider } from "@lingui/solid"
        import { createComponent, createSignal, onMount, onCleanup } from "solid-js"
        import { render } from "solid-js/web"
        import { DialogProvider, useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
        import { SettingsDialogFrame } from ${JSON.stringify(`/@fs/${componentPath}`)}

        import { useSettingsSave } from "/@fs/${path.resolve(import.meta.dir, "../../../src/components/settings/hooks/useSettingsSave.ts")}"
        import { useConfirm } from "/@fs/${path.resolve(import.meta.dir, "../../../src/components/dialog/confirm-dialog.tsx")}"
        import "/@fs/${path.resolve(import.meta.dir, "../../../src/components/settings/settings-panel.css")}"
        import { SettingRow } from "@ericsanchezok/synergy-ui/setting-row"
        import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
        import { SettingsChoices } from "/@fs/${path.resolve(import.meta.dir, "../../../src/components/settings/components/SettingsChoices.tsx")}"
        import { locateSettingsField } from "/@fs/${path.resolve(import.meta.dir, "../../../src/components/settings/settings-search.ts")}"
        function Settings() {
          const dialog = useDialog()
          const confirm = useConfirm()
          let fields
          let cleanupSearch
          const [showFields, setShowFields] = createSignal(false)
          const [choice, setChoice] = createSignal("auto")
          onCleanup(() => cleanupSearch?.())
          const locate = (label) => {
            cleanupSearch?.()
            cleanupSearch = locateSettingsField(fields, label)
            setShowFields(true)
          }
          const [draft, setDraft] = createSignal("")
          const [saved, setSaved] = createSignal("")
          const save = useSettingsSave({
            serverPatch: () => draft() === saved() ? {} : { username: draft() },
            serverDraft: draft,
            domainSummaries: () => [{ id: "general", ownedKeys: ["username"] }],
            hasAnyChanges: () => draft() !== saved(),
            editingLabel: () => "General",
            refreshAfterConfigChange: async (_fields, value) => setSaved(value),
            discardChanges: () => setDraft(saved()),
            closeDialog: () => dialog.close(),
            showConfirm: confirm.show,
          })
          return <SettingsDialogFrame ariaLabel="Settings" onRequestClose={save.closeWithGuard}>
            <input aria-label="Draft" value={draft()} onInput={e => setDraft(e.currentTarget.value)} />
            <input aria-label="Inline editor" on:keydown={event => { if (event.key === "Escape") event.preventDefault() }} />
            <button onClick={save.closeWithGuard}>Close settings</button>
            <button onClick={save.closeWithGuard}>Cancel settings</button>
            <button onClick={() => void save.saveServerChanges()}>Save settings</button>
            <output>{save.status()}</output>
            <MenuField ariaLabel="Language" value="en" onChange={() => {}} options={[{ value: "en", label: "English" }, { value: "zh", label: "Chinese" }]} />
            <button onClick={() => locate("Interface font")}>Find interface font</button>
            <button onClick={() => locate("Monospace font")}>Find monospace font</button>
            <div ref={fields} class="settings-panel-content" style="height:100px;width:500px;max-width:100%;overflow:auto;--border-interactive-focus:currentColor" data-testid="fields">
              {showFields() && <><div style="height:400px" />
                <SettingRow title="Interface font" description="Choose your interface font" controlLayout="group" statePlacement="description" stateLabel="Selected font will apply after saving" trailing={<div class="settings-font-controls"><button>Choose interface font</button><button>Check fonts</button></div>} />
                <div style="height:200px" />
                <SettingRow title="Monospace font" description="Choose your code font" trailing={<button>Choose monospace font</button>} />
                <SettingsChoices ariaLabel="Color" value={choice()} options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }, { value: "auto", label: "Auto" }]} onChange={setChoice} />
              </>}
            </div>
          </SettingsDialogFrame>
        }
        const i18n = setupI18n({ locale: "en" })
        i18n.loadAndActivate({ locale: "en", messages: {} })

        function Harness() {
          const dialog = useDialog()
          onMount(() => {
            dialog.show(() => <Settings />)
          })
          return null
        }

        render(
          () =>
            createComponent(I18nProvider, {
              i18n,
              get children() {
                return createComponent(DialogProvider, {
                  get children() {
                    return createComponent(Harness, {})
                  },
                })
              },
            }),
          document.querySelector("#root")!,
        )
      `,
    ),
  ])

  await Bun.write(
    path.join(fixtureDirectory, "sdk.ts"),
    `
    import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
    export function useGlobalSDK() { return { client: createSynergyClient({ baseUrl: location.origin }) } }
  `,
  )
  server = await createServer({
    configFile: false,
    root: fixtureDirectory,
    plugins: [solidPlugin()],
    cacheDir: path.join(fixtureDirectory, ".vite"),
    optimizeDeps: {
      noDiscovery: true,
      include: ["solid-js", "solid-js/web", "solid-js/store", "@lingui/core", "@lingui/solid", "jsonc-parser"],
    },
    resolve: {
      alias: [
        { find: "@/context/global-sdk", replacement: path.join(fixtureDirectory, "sdk.ts") },
        { find: "@", replacement: path.resolve(import.meta.dir, "../../../src") },
      ],
    },
    server: {
      host: "127.0.0.1",
      port: await fixturePort(),
      strictPort: true,
      fs: { allow: [path.resolve(import.meta.dir, "../../../..")] },
    },
  })
  await server.listen()
  await server.warmupRequest("/main.tsx")

  const url = server.resolvedUrls?.local[0]
  if (!url) throw new Error("Expected Vite test server URL")

  browser = await chromium.launch({ headless: true })
  fixtureUrl = url
}, 75_000)

afterAll(async () => {
  await page?.close()
  await browser?.close()
  await server?.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

async function loadSettings() {
  await page?.close()
  errors.length = 0
  page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  page.setDefaultTimeout(5000)
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(fixtureUrl, { timeout: 60_000, waitUntil: "domcontentloaded" })
  await page.getByRole("textbox", { name: "Draft" }).waitFor({ timeout: 20000 })
}

afterEach(() => expect(errors).toEqual([]))

describe("Settings dialog dismissal", () => {
  test("Escape consumed by an inline control never requests Settings dismissal", async () => {
    await loadSettings()
    await page.getByRole("textbox", { name: "Inline editor" }).press("Escape")
    expect(await page.getByRole("dialog", { name: "Settings", exact: true }).count()).toBe(1)
  })

  test("Escape from a focused settings option closes its menu before the draft guard", async () => {
    for (const draft of ["", "Keep my draft"]) {
      await loadSettings()
      await page.getByRole("textbox", { name: "Draft" }).fill(draft)
      const trigger = page.getByRole("button", { name: "Language: English", exact: true })
      await trigger.click()
      await page.getByRole("option", { name: "Chinese", exact: true }).press("Escape")
      await page.getByRole("option", { name: "Chinese", exact: true }).waitFor({ state: "detached" })
      expect(await page.getByRole("dialog", { name: "Settings", exact: true }).count()).toBe(1)
      expect(await page.getByRole("dialog").count()).toBe(1)
      expect(await page.getByRole("textbox", { name: "Draft" }).inputValue()).toBe(draft)
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Language: English")
      await trigger.press("Escape")
      if (draft) await page.getByRole("dialog", { name: "Discard unsaved changes?", exact: true }).waitFor()
      else await page.getByRole("dialog", { name: "Settings", exact: true }).waitFor({ state: "detached" })
    }
  })

  test("focusing a lower radio option scrolls the content without displacing the fixed dialog body", async () => {
    await loadSettings()
    await page.getByRole("button", { name: "Find interface font", exact: true }).click()
    await page.getByRole("radio", { name: "Auto", exact: true }).press("ArrowUp")
    expect(await page.getByRole("radio", { name: "Dark", exact: true }).isChecked()).toBe(true)
    expect(await page.locator('[data-slot="dialog-body"]').evaluate((el) => el.scrollTop)).toBe(0)
    const bounds = await page.getByRole("radio", { name: "Dark", exact: true }).evaluate((el) => ({
      y: el.getBoundingClientRect().y,
      bottom: el.getBoundingClientRect().bottom,
      container: document.querySelector('[data-testid="fields"]')!.getBoundingClientRect().toJSON(),
    }))
    expect(bounds.y).toBeGreaterThanOrEqual(bounds.container.top)
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.container.bottom)
  })
  test("discard confirmation names its close action and initially focuses continuing to edit", async () => {
    await loadSettings()
    await page.getByRole("textbox", { name: "Draft" }).fill("Keep my draft")
    await page.getByRole("button", { name: "Close settings", exact: true }).click()
    const confirmation = page.getByRole("dialog", { name: "Discard unsaved changes?", exact: true })
    await confirmation.waitFor()
    expect(
      await confirmation.getByRole("button", { name: "Close Discard unsaved changes?", exact: true }).count(),
    ).toBe(1)
    expect(
      await confirmation
        .getByRole("button", { name: "Keep Editing", exact: true })
        .evaluate((el) => ({ focused: el === document.activeElement, active: document.activeElement?.outerHTML })),
    ).toMatchObject({ focused: true })
  })

  test("a field group keeps its state beside the description and stacks controls at narrow content widths", async () => {
    await loadSettings()
    await page.getByRole("button", { name: "Find interface font", exact: true }).click()
    const row = page.locator(".ds-setting-row").filter({ hasText: "Interface font" })
    const boxes = await row.evaluate((el) => {
      const box = (selector: string) => {
        const rect = el.querySelector(selector)!.getBoundingClientRect()
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      }
      return {
        state: box(".settings-row-state"),
        description: box(".settings-row-description"),
        controls: box(".settings-font-controls"),
      }
    })
    expect(boxes.state.x).toBe(boxes.description.x)
    expect(boxes.state.width).toBeGreaterThan(150)
    expect(boxes.controls.y).toBeGreaterThanOrEqual(boxes.state.y + boxes.state.height)
  })

  test("Escape closes clean settings while the backdrop stays inert", async () => {
    await loadSettings()
    await page.getByRole("textbox", { name: "Draft" }).waitFor()
    const overlay = page.locator('[data-component="dialog-overlay"]')
    await overlay.dispatchEvent("pointerdown")
    await overlay.dispatchEvent("click")
    expect(await page.getByRole("dialog", { name: "Settings", exact: true }).count()).toBe(1)
    await page.keyboard.press("Escape")
    await page.getByRole("dialog", { name: "Settings", exact: true }).waitFor({ state: "detached" })
  })

  test("Escape, close and cancel share the dirty guard, and nested Escape only dismisses confirmation", async () => {
    await loadSettings()
    await page.getByRole("textbox", { name: "Draft" }).fill("Keep my draft")
    for (const action of ["Escape", "Close settings", "Cancel settings"]) {
      if (action === "Escape") await page.keyboard.press("Escape")
      else await page.getByRole("button", { name: action, exact: true }).click()
      await page.locator('[role="dialog"]').nth(1).waitFor()
      expect(await page.locator('[role="dialog"]').count()).toBe(2)
      await page.keyboard.press("Escape")
      await page.locator('[role="dialog"]').nth(1).waitFor({ state: "detached" })
      expect(await page.getByRole("textbox", { name: "Draft" }).inputValue()).toBe("Keep my draft")
    }
    await page.getByRole("button", { name: "Close settings", exact: true }).click()
    await page.locator('[role="dialog"]').nth(1).getByRole("button", { name: "Discard", exact: true }).click()
    await page.getByRole("dialog").waitFor({ state: "detached" })
  })

  test("field navigation waits for rendered rows, scrolls and moves focus, then clears the previous match", async () => {
    await loadSettings()
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.getByRole("button", { name: "Find interface font", exact: true }).click()
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-settings-search-match") === "true")
    expect(await page.locator("[data-settings-search-match]").innerText()).toContain("Interface font")
    expect(await page.getByTestId("fields").evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    await page.getByRole("button", { name: "Find monospace font", exact: true }).click()
    expect(await page.locator("[data-settings-search-match]").count()).toBe(1)
    expect(await page.locator("[data-settings-search-match]").innerText()).toContain("Monospace font")
    expect(await page.locator(".ds-setting-row").first().getAttribute("tabindex")).toBeNull()
  })

  test("pending saves reject close and duplicates; HTTP failure keeps the draft and retry success stays open", async () => {
    await loadSettings()
    let writes = 0
    let release: (() => void) | undefined
    let fail = true
    await page.route("**/config/domains/general", async (route) => {
      writes++
      await new Promise<void>((resolve) => {
        release = resolve
      })
      await route.fulfill({
        status: fail ? 503 : 200,
        contentType: "application/json",
        body: JSON.stringify(fail ? { message: "Temporary failure" } : { changedFields: ["username"] }),
      })
    })
    await page.getByRole("textbox", { name: "Draft" }).fill("Keep after failure")
    await page.getByRole("button", { name: "Save settings", exact: true }).click()
    await page.waitForFunction(() => document.querySelector("output")?.textContent === "saving")
    await page.getByRole("button", { name: "Save settings", exact: true }).click()
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "Close settings", exact: true }).click()
    expect(await page.getByRole("dialog").count()).toBe(1)
    expect(writes).toBe(1)
    release!()
    await page.waitForFunction(() => document.querySelector("output")?.textContent === "error")
    expect(await page.getByRole("textbox", { name: "Draft" }).inputValue()).toBe("Keep after failure")
    fail = false
    await page.getByRole("button", { name: "Save settings", exact: true }).click()
    await page.waitForFunction(() => document.querySelector("output")?.textContent === "saving")
    while (writes < 2) await new Promise((resolve) => setTimeout(resolve, 10))
    release!()
    await page.waitForFunction(() => document.querySelector("output")?.textContent === "saved")
    expect(await page.getByRole("dialog").count()).toBe(1)
    expect(writes).toBe(2)
    await page.unroute("**/config/domains/general")
  }, 15_000)
})
