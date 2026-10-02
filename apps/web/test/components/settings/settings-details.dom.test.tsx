import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
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
let fixture: string
let url: string
const errors: string[] = []

beforeAll(async () => {
  fixture = await mkdtemp(path.join(import.meta.dir, ".settings-details-"))
  const source = path.resolve(import.meta.dir, "../../../src")
  await Bun.write(
    path.join(fixture, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(fixture, "sdk.ts"),
    `
    const calls = { plan: 0, apply: 0, read: 0, status: [] }
    window.fixtureCalls = calls
    const domain = { id: "general", filename: "general.jsonc", label: "General", path: "/fixture/general.jsonc", changes: [], diagnostics: [], mode: "merge" }
    const plan = { scope: "global", revision: "fixture-revision", domains: [domain], conflicts: [], diagnostics: [] }
    export const domains = [{ ...domain, ownedKeys: ["username"], uiSection: "general", importable: true, reloadTargets: [] }]
    export const scopes = [{ id: "scope-fixture", name: "Fixture project", type: "project", local: { worktree: "/fixture/project", directory: "/fixture/project", sandboxes: [] }, time: { created: 1, updated: 1 } }]
    export function useGlobalSDK() { return { client: {
      config: { import: {
        plan: async () => { calls.plan++; return { data: plan } },
        apply: async () => { calls.apply++; return { data: { plan, reload: { success: true, changedFields: ["username"], requested: [], executed: [], targets: [], errors: [], restartRequired: [] } } } }
      } },
      formatter: { status: async input => { calls.status.push(input); if (location.search.includes("failure")) throw new Error("Status unavailable"); return { data: [{ name: "fixture-formatter", extensions: [".ts"], enabled: true }] } } },
      lsp: { status: async input => { calls.status.push(input); return { data: [] } } }
    } } }
    export async function refresh() { calls.read++; if (calls.read === 1) throw new Error("Read failed") }
  `,
  )
  await Bun.write(path.join(fixture, "toast.ts"), "export function showToast() {}")
  await Bun.write(
    path.join(fixture, "sync.ts"),
    "export function useGlobalSync() { return { data: { config: { fullAccessAcknowledged: true } } } }",
  )
  await Bun.write(
    path.join(fixture, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { createSignal, Show } from "solid-js"
    import { createStore } from "solid-js/store"
    import { setupI18n } from "@lingui/core"
    import { I18nProvider } from "@lingui/solid"
    import { DialogProvider } from "@ericsanchezok/synergy-ui/context/dialog"
    import { TextField } from "@ericsanchezok/synergy-ui/text-field"
    import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
    import { EmailPanel } from "/@fs/${source}/components/settings/panels/EmailPanel.tsx"
    import { ImportPanel } from "/@fs/${source}/components/settings/panels/ImportPanel.tsx"
    import { LanguageToolsPanel } from "/@fs/${source}/components/settings/panels/LanguageToolsPanel.tsx"
    import { ControlProfilePanel } from "/@fs/${source}/components/settings/panels/SafetyPanels.tsx"
    import { SettingsPathRow, SettingsPage } from "/@fs/${source}/components/settings/components/SettingsPrimitives.tsx"
    import { SettingRow } from "/@fs/${source}/components/settings/components/SettingsSettingRow.tsx"
    import { SettingsChoices } from "/@fs/${source}/components/settings/components/SettingsChoices.tsx"
    import { SettingsStepScale } from "/@fs/${source}/components/settings/components/SettingsStepScale.tsx"
    import { defaultSettingsState } from "/@fs/${source}/components/settings/types.ts"
    import "/@fs/${source}/components/settings/settings-panel.css"
    import "@ericsanchezok/synergy-ui/styles"
    import { messages as en } from "/@fs/${source}/locales/en/messages.po"
    import { messages as zh } from "/@fs/${source}/locales/zh-CN/messages.po"
    import { domains, scopes, refresh } from "./sdk"
    const query = new URLSearchParams(location.search)
    const i18n = setupI18n({ locale: query.get("locale") || "en", messages: { en, "zh-CN": zh } })
    document.documentElement.dataset.colorScheme = query.get("theme") || "light"
    function Fixture() {
      const [view, setView] = createSignal("email")
      const [email, setEmail] = createStore(defaultSettingsState().email)
      const [choice, setChoice] = createSignal("ask")
      const [safety, setSafety] = createStore(defaultSettingsState().safety)
      return <div class="settings-panel-frame"><nav><button onClick={() => setView("import")}>Import page</button><button onClick={() => setView("formatter")}>Formatter page</button><button onClick={() => setView("controls")}>Controls page</button><button onClick={() => setView("paths")}>Config files page</button><button onClick={() => setView("profiles")}>Permissions page</button></nav><main class="settings-panel-content">
        <Show when={view() === "email"}><EmailPanel email={email} onEmailChange={(key, value) => setEmail(key, value)} /></Show>
        <Show when={view() === "import"}><ImportPanel domains={domains} scopes={scopes} onImported={refresh} /></Show>
        <Show when={view() === "formatter"}><LanguageToolsPanel kind="formatter" title="Formatter" description="Formatter configuration" config={{ formatter: { custom: { command: ["fixture"], extensions: [".tsx"] } }, lsp: { unrelated: { command: ["do-not-show"] } }, timeout: { invoke: 123 } }} scopes={scopes} domains={[]} /></Show>
        <Show when={view() === "paths"}><SettingsPage title="Config Files"><SettingsPathRow compact label="90-channels.jsonc" path={"/fixture/config/" + "long-directory/".repeat(12) + "90-channels.jsonc"} status="Empty" ownedKeys={["channel"]} mergePolicy="merge" /></SettingsPage></Show>
        <Show when={view() === "profiles"}><ControlProfilePanel safety={safety} controlProfiles={[]} onSafetyChange={(key, value) => setSafety(key, value)} /></Show>
        <Show when={view() === "controls"}><div class="ds-page-inner">
          <SettingRow title="Sending port" description="Use a valid port" stateLabel="Unsaved" trailing={<TextField type="number" validationState="invalid" error="Enter a whole number" value="0" copyable />} />
          <SettingRow title="Policy" description="Requests wait for approval" trailing={<SettingsChoices ariaLabel="Policy" value={choice()} options={[{ value: "ask", label: "Ask" }, { value: "allow", label: "Allow" }, { value: "deny", label: "Deny" }]} onChange={setChoice} />} />
          <SettingRow title="Duration" description="Ordered durations" trailing={<SettingsStepScale ariaLabel="Duration" value="37" options={[{ value: "10", label: "Short" }, { value: "60", label: "Long" }]} onChange={() => {}} />} />
          <SettingRow title="Font" description="Choose a typeface" stateLabel="Current font: system" trailing={<MenuField value="" ariaLabel="Font" options={[{ value: "", label: "System default" }]} onChange={() => {}} />} />
        </div></Show>
      </main></div>
    }
    render(() => <I18nProvider i18n={i18n}><DialogProvider><Fixture /></DialogProvider></I18nProvider>, document.getElementById("root"))
  `,
  )
  server = await createServer({
    configFile: false,
    root: fixture,
    plugins: [solidPlugin(), tailwindcss(), ...lingui()],
    cacheDir: path.join(fixture, ".vite"),
    optimizeDeps: {
      noDiscovery: true,
      include: ["solid-js", "solid-js/web", "solid-js/store", "@lingui/core", "@lingui/solid", "jsonc-parser"],
    },
    resolve: {
      alias: [
        { find: "@/context/global-sdk", replacement: path.join(fixture, "sdk.ts") },
        { find: "@/context/global-sync", replacement: path.join(fixture, "sync.ts") },
        { find: "@ericsanchezok/synergy-ui/toast", replacement: path.join(fixture, "toast.ts") },
        { find: "@/", replacement: source + "/" },
      ],
    },
    server: {
      host: "127.0.0.1",
      port: await fixturePort(),
      fs: { allow: [path.resolve(import.meta.dir, "../../../..")] },
    },
  })
  await server.listen()
  url = server.resolvedUrls!.local[0]!
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.setDefaultTimeout(5000)
  page.on("pageerror", (error) => errors.push(error.message))
}, 60000)

beforeEach(async () => {
  errors.length = 0
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 })
  await page.getByRole("heading", { name: "Email", exact: true }).waitFor({ timeout: 30000 })
})
afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (fixture) await rm(fixture, { recursive: true, force: true })
})

test("email tasks retain their drafts and report incomplete configurations without claiming health", async () => {
  expect(await page.getByLabel("Reading host", { exact: true }).count()).toBe(0)
  await page.getByLabel("Sending host", { exact: true }).fill("smtp.fixture")
  await page
    .getByText("Sending: Incomplete. Reading: Not configured. Server connections have not been verified.", {
      exact: true,
    })
    .waitFor()
  await page.getByRole("tab", { name: "Sending", exact: true }).press("ArrowRight")
  await page.getByLabel("Reading host", { exact: true }).fill("imap.fixture")
  expect(await page.getByLabel("Sending host", { exact: true }).count()).toBe(0)
  await page.getByRole("tab", { name: "Reading", exact: true }).press("Home")
  expect(await page.getByLabel("Sending host", { exact: true }).inputValue()).toBe("smtp.fixture")
  expect(errors).toEqual([])
})

test("import parse errors stay associated with the input and an applied import retries only reading", async () => {
  await page.getByRole("button", { name: "Import page" }).click()
  const input = page.getByRole("textbox", { name: "Paste JSON or JSONC" })
  await input.fill('{\n "username": }')
  await page.getByRole("button", { name: "Review Paste" }).click()
  await page.getByRole("alert").waitFor()
  expect(await input.getAttribute("aria-invalid")).toBe("true")
  const description = await input.getAttribute("aria-describedby")
  expect(await page.locator(`[id="${description}"]`).innerText()).toContain("line 2")
  await input.fill('{"username":"Fixture"}')
  await page.getByRole("button", { name: "Review Paste" }).click()
  await page.getByRole("button", { name: "Apply", exact: true }).click()
  await page.getByText("Configuration imported. The view still needs to update.", { exact: true }).waitFor()
  await page.getByRole("button", { name: "Retry reading" }).click()
  expect(await page.evaluate("window.fixtureCalls")).toMatchObject({ plan: 1, apply: 1, read: 2 })
  expect(await page.getByRole("button", { name: "Apply", exact: true }).isEnabled()).toBe(false)
  expect(errors).toEqual([])
})

test("formatter status is scoped to a chosen project and its page excludes unrelated runtime configuration", async () => {
  await page.getByRole("button", { name: "Formatter page" }).click()
  expect(await page.getByText("custom", { exact: true }).count()).toBe(1)
  expect(await page.getByText("unrelated", { exact: true }).count()).toBe(0)
  expect(await page.evaluate<{ scopeID: string }[]>("window.fixtureCalls.status")).toEqual([])
  await page.getByRole("button", { name: "Project: Select a project" }).click()
  await page.getByRole("option", { name: "Fixture project" }).click()
  await page.getByText("fixture-formatter", { exact: true }).waitFor()
  expect(await page.evaluate<{ scopeID: string }[]>("window.fixtureCalls.status")).toEqual([
    { scopeID: "scope-fixture" },
  ])
  expect(errors).toEqual([])
})

test("settings controls expose field descriptions, errors, object names and radio keyboard selection", async () => {
  await page.getByRole("button", { name: "Controls page" }).click()
  const input = page.getByRole("spinbutton", { name: "Sending port", exact: true })
  const descriptions = (await input.getAttribute("aria-describedby"))?.split(" ") ?? []
  const texts = await Promise.all(descriptions.map((id) => page.locator(`[id="${id}"]`).innerText()))
  expect(texts.join(" ")).toContain("Use a valid port")
  expect(texts.join(" ")).toContain("Enter a whole number")
  expect(await page.getByRole("button", { name: "Copy Sending port", exact: true }).count()).toBe(1)
  await page.getByRole("radio", { name: "Ask", exact: true }).focus()
  await page.getByRole("radio", { name: "Ask", exact: true }).press("ArrowDown")
  expect(await page.getByRole("radio", { name: "Allow", exact: true }).isChecked()).toBe(true)
  expect(await page.getByRole("slider", { name: "Duration", exact: true }).getAttribute("aria-valuetext")).toBe(
    "Custom 37",
  )
  expect(errors).toEqual([])
})

test("wide and narrow settings selectors keep the value leading and the chevron trailing", async () => {
  for (const width of [1280, 375, 320]) {
    await page.setViewportSize({ width, height: 800 })
    await page.getByRole("button", { name: "Controls page" }).click()
    const trigger = page.getByRole("button", { name: "Font: System default" })
    const bounds = await trigger.evaluate((element) => {
      const box = element.getBoundingClientRect()
      const value = element.querySelector(".menu-field-value")!.getBoundingClientRect()
      const chevron = element.querySelector(".menu-field-chevron")!.getBoundingClientRect()
      return {
        left: box.left,
        right: box.right,
        valueLeft: value.left,
        valueRight: value.right,
        arrowLeft: chevron.left,
        arrowRight: chevron.right,
      }
    })
    expect(bounds.arrowRight).toBeGreaterThanOrEqual(bounds.right - 16)
    expect(bounds.valueLeft).toBeLessThanOrEqual(bounds.left + 16)
    expect(bounds.valueRight).toBeLessThan(bounds.arrowLeft)
    await trigger.click()
    await page.getByRole("option", { name: "System default", exact: true }).waitFor()
    await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "option")
    await page.keyboard.press("Escape")
    await trigger.waitFor({ state: "visible" })
    await page.waitForFunction(() => document.activeElement?.classList.contains("menu-field-trigger"))
    expect(errors).toEqual([])
  }
})

test("expanded configuration details inset readable paths and keep actions reachable without overflow", async () => {
  await page.getByRole("button", { name: "Config files page" }).click()
  const summary = page.locator(".ds-path-index > summary")
  await summary.focus()
  await summary.press("Enter")
  for (const width of [1280, 375, 320]) {
    await page.setViewportSize({ width, height: 800 })
    const detail = page.locator(".ds-path-index .ds-path-row")
    const pathText = page.locator(".ds-path-text")
    const metrics = await detail.evaluate((element) => {
      const style = getComputedStyle(element)
      const path = element.querySelector(".ds-path-text")!
      const pathStyle = getComputedStyle(path)
      const frameStyle = getComputedStyle(element.closest(".settings-panel-frame")!)
      return {
        padding: parseFloat(style.paddingInlineStart),
        font: pathStyle.fontFamily,
        expectedFont: frameStyle.getPropertyValue("--font-family-mono").trim(),
        overflow: element.scrollWidth > element.clientWidth,
        wordBreak: pathStyle.wordBreak,
        fontSize: parseFloat(pathStyle.fontSize),
      }
    })
    expect(metrics.padding).toBeGreaterThanOrEqual(12)
    expect(metrics.font).toBe(metrics.expectedFont)
    expect(metrics.fontSize).toBeLessThanOrEqual(14)
    expect(metrics.wordBreak).toBe("normal")
    expect(metrics.overflow).toBe(false)
    const copy = page.getByRole("button", { name: "Copy path: 90-channels.jsonc" })
    const copyBounds = await copy.boundingBox()
    expect(copyBounds!.x + copyBounds!.width).toBeLessThanOrEqual(width)
    expect(await pathText.textContent()).toEndWith("90-channels.jsonc")
  }
  await summary.press("Enter")
  expect(await page.getByRole("button", { name: "Copy path: 90-channels.jsonc" }).isVisible()).toBe(false)
  expect(errors).toEqual([])
})

test("Chinese permission choices use the same names and canonical values in both session scopes", async () => {
  await page.goto(url + "?locale=zh-CN", { waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: "Permissions page" }).click()
  const regular = page.getByRole("radiogroup", { name: "权限模式", exact: true })
  const nonInteractive = page.getByRole("radiogroup", { name: "非交互会话的权限模式", exact: true })
  for (const name of ["无人值守", "完全访问权限"]) {
    expect(await regular.getByRole("radio", { name: new RegExp(`^${name}`) }).count()).toBe(1)
    expect(await nonInteractive.getByRole("radio", { name, exact: true }).count()).toBe(1)
  }
  expect(await nonInteractive.getByRole("radio", { name: "无人值守", exact: true }).inputValue()).toBe("autonomous")
  expect(await nonInteractive.getByRole("radio", { name: "完全访问权限", exact: true }).inputValue()).toBe(
    "full_access",
  )
  expect(errors).toEqual([])
})
