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
        import { locateSettingsField } from "/@fs/${path.resolve(import.meta.dir, "../../../src/components/settings/settings-search.ts")}"
        function Settings() {
          const dialog = useDialog()
          const confirm = useConfirm()
          let fields
          let cleanupSearch
          const [showFields, setShowFields] = createSignal(false)
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
            <button onClick={save.closeWithGuard}>Close settings</button>
            <button onClick={save.closeWithGuard}>Cancel settings</button>
            <button onClick={() => void save.saveServerChanges()}>Save settings</button>
            <output>{save.status()}</output>
            <button onClick={() => locate("Interface font")}>Find interface font</button>
            <button onClick={() => locate("Monospace font")}>Find monospace font</button>
            <div ref={fields} class="settings-panel-content" style="height:100px;overflow:auto;--border-interactive-focus:currentColor" data-testid="fields">
              {showFields() && <><div style="height:400px" />
                <SettingRow title="Interface font" description="Choose your interface font" trailing={<button>Choose interface font</button>} />
                <div style="height:200px" />
                <SettingRow title="Monospace font" description="Choose your code font" trailing={<button>Choose monospace font</button>} />
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
    resolve: {
      alias: [
        { find: "@/context/global-sdk", replacement: path.join(fixtureDirectory, "sdk.ts") },
        { find: "@", replacement: path.resolve(import.meta.dir, "../../../src") },
      ],
    },
    server: {
      host: "127.0.0.1",
      port: 5204,
      strictPort: true,
      fs: { allow: [path.resolve(import.meta.dir, "../../../..")] },
    },
  })
  await server.listen()

  const url = server.resolvedUrls?.local[0]
  if (!url) throw new Error("Expected Vite test server URL")

  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  page.setDefaultTimeout(2500)
  await page.goto(url, { timeout: 20_000 })
}, 30_000)

afterAll(async () => {
  await page?.close()
  await browser?.close()
  await server?.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

describe("Settings dialog dismissal", () => {
  test("Escape closes clean settings while the backdrop stays inert", async () => {
    await page.reload()
    await page.getByRole("textbox", { name: "Draft" }).waitFor()
    const overlay = page.locator('[data-component="dialog-overlay"]')
    await overlay.dispatchEvent("pointerdown")
    await overlay.dispatchEvent("click")
    expect(await page.getByRole("dialog", { name: "Settings", exact: true }).count()).toBe(1)
    await page.keyboard.press("Escape")
    await page.getByRole("dialog", { name: "Settings", exact: true }).waitFor({ state: "detached" })
  })

  test("Escape, close and cancel share the dirty guard, and nested Escape only dismisses confirmation", async () => {
    await page.reload()
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
    await page.reload()
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
    await page.reload()
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
