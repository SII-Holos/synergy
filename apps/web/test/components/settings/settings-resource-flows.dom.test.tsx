import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../../support/browser-fixture"

let browser: Browser
let page: Page
let server: BrowserFixture
let fixture: string
let url: string
const errors: string[] = []
type FixtureFlags = {
  __failRead?: boolean
  __failWrite?: boolean
  __catalogFailure?: boolean
  __loseCreateResponse?: boolean
  __pauseWrite?: boolean
}
interface FixtureWindow extends Window, FixtureFlags {
  __resourceCalls: {
    writes: { providerID: string }[]
    creations: { id: string }[]
    authorizations: { providerID: string }[]
    toasts: unknown[]
  }
  __finishOAuth(): void
  __releaseWrite(): void
}
function calls(key: "writes"): Promise<{ providerID: string }[]>
function calls(key: "creations"): Promise<{ id: string }[]>
function calls(key: "writes" | "creations") {
  return page.evaluate((key) => (window as unknown as FixtureWindow).__resourceCalls[key], key)
}
const flags = (value: FixtureFlags) =>
  page.evaluate((value) => {
    Object.assign(window, value)
  }, value)

beforeAll(async () => {
  fixture = await mkdtemp(path.join(import.meta.dir, ".settings-resources-"))
  const app = path.resolve(import.meta.dir, "../../../src")
  await Bun.write(
    path.join(fixture, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(fixture, "api.ts"),
    `
    import { createStore } from "solid-js/store"
    import { createIntlFormatter } from "/@fs/${app}/context/locale/formatter.ts"
    export function useLocale() { return { fmt: createIntlFormatter(() => new URLSearchParams(location.search).get("locale") || "en") } }
    const capabilities = { reasoning: true, input: { text: true, image: false, pdf: false, video: false, audio: false }, output: { text: true, audio: false } }
    const model = { id: "chat", name: "Test Chat", capabilities, cost: { input: 1, output: 1 }, variants: {} }
    const base = (id, connected) => ({ id, name: id === "deepseek" ? "DeepSeek" : id === "openai-codex" ? "OpenAI Codex" : "Test Service", profileID: id, catalogProviderID: id, configured: true, enabled: true, removable: false, canCreateSibling: true, connected, modelCount: 1, models: { chat: model }, catalog: { source: "live", refreshing: false, lastVerifiedAt: 1791028800000 }, health: { status: connected ? "connected" : "unconfigured", source: "api" } })
    const [data, setData] = createStore({ provider: { all: [base("deepseek", true), base("test-service", false), base("openai-codex", false)], connected: ["deepseek"], profiles: {}, default: { deepseek: "chat" } }, provider_auth: { deepseek: [{ type: "api", label: "API key" }], "test-service": [{ type: "api", label: "API key" }], "openai-codex": [{ type: "oauth", label: "Login with ChatGPT" }, { type: "import", label: "Import Codex CLI credentials" }] } })
    setData("provider", "connections", Object.fromEntries(data.provider.all.map(item => [item.id, item])))
    const writes = []; const creations = []; const authorizations = []; const toasts = []; const authenticated = new Set(["deepseek"])
    window.__resourceCalls = { writes, creations, authorizations, toasts }
    window.__useImport = () => setData("provider_auth", "test-service", [{ type: "import", label: "Import credentials" }])
    window.__publishModelCatalog = () => setData("provider", "all", 0, "models", {
      chat: model,
      "new-model": { ...model, id: "new-model", name: "Test New Model" },
    })
    export const summaries = () => data.provider.all.map(provider => ({ ...provider, connected: data.provider.connected.includes(provider.id) }))
    export function useGlobalSync() { return { data, refreshProviders: async () => { if (window.__failRead) { window.__failRead = false; throw new Error("Refresh failed") } setData("provider", "connected", [...authenticated]); setData("provider", "all", item => ({ ...item, health: { ...item.health, status: authenticated.has(item.id) ? "connected" : "unconfigured" } })) } } }
    export function useGlobalSDK() { return { client: {
      auth: { set: async input => { if (window.__pauseWrite) await new Promise(resolve => { window.__releaseWrite = resolve }); if (window.__failWrite) throw { data: { message: "Credential rejected" } }; writes.push(input); authenticated.add(input.providerID) } },
      provider: { oauth: {
        authorize: async input => { authorizations.push(input); return { data: { method: "auto", url: "https://example.com/authorize", instructions: "Code: FIXTURE" } } },
        callback: async (input, options) => { await new Promise(resolve => { window.__finishOAuth = resolve }); authenticated.add(input.providerID); return {} }
      }, credentials: { importCredentials: async input => { writes.push(input); authenticated.add(input.providerID) } }, models: { refresh: async ({ providerID }) => {
        const catalog = { source: "live", refreshing: false, lastVerifiedAt: 1791028800000, ...(window.__catalogFailure ? { failure: "network" } : {}) }
        setData("provider", "all", item => item.id === providerID, "catalog", catalog)
        if (!window.__catalogFailure) setData("provider", "all", item => item.id === providerID, "catalog", "failure", undefined)
        return { data: catalog }
      } }, connection: {
        create: async ({ providerConnectionCreateInput: input }) => { creations.push(input); const account = { ...base(input.profileID, false), id: input.id, name: input.name, removable: true }; setData("provider", "all", [...data.provider.all, account]); setData("provider", "connections", input.id, account); if (window.__loseCreateResponse) { window.__loseCreateResponse = false; throw new Error("Response lost") } return { data: account } },
        update: async () => ({ data: data.provider.all[0] }), remove: async () => {} }, disconnect: async () => {} }
    } } }
    export function useProviders() { return { all: () => data.provider.all, connected: () => data.provider.all.filter(provider => data.provider.connected.includes(provider.id)), default: () => data.provider.default, ensureCatalog: async () => {} } }
    export function useLocal() { return { model: { current: () => undefined, set: () => { window.__sessionChanged = true } } } }
    export function usePlatform() { return { openLink: () => {} } }
  `,
  )
  await Bun.write(
    path.join(fixture, "toast.ts"),
    "export function showToast(value) { window.__resourceCalls.toasts.push(value) }",
  )
  await Bun.write(
    path.join(fixture, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { createSignal, Show } from "solid-js"
    import { createStore } from "solid-js/store"
    import { setupI18n } from "@lingui/core"
    import { I18nProvider } from "@lingui/solid"
    import { ThemeProvider, useTheme } from "@ericsanchezok/synergy-ui/theme"
    import { DialogProvider } from "@ericsanchezok/synergy-ui/context/dialog"
    import { createProviderSetupDrafts } from "/@fs/${app}/components/provider/provider-setup-drafts.ts"
    import { ProvidersPanel } from "/@fs/${app}/components/settings/panels/ProvidersPanel.tsx"
    import { ModelsPanel } from "/@fs/${app}/components/settings/panels/ModelsPanel.tsx"
    import { MODEL_ROLES, defaultSettingsState } from "/@fs/${app}/components/settings/types.ts"
    import { summaries, useGlobalSync } from "./api"
    import { providerFlow } from "/@fs/${app}/locales/messages.ts"
    import "/@fs/${app}/components/settings/settings-panel.css"
    import "@ericsanchezok/synergy-ui/styles"
    import { messages as en } from "/@fs/${app}/locales/en/messages.po"
    import { messages as zh } from "/@fs/${app}/locales/zh-CN/messages.po"
    const query = new URLSearchParams(location.search)
    const i18n = setupI18n({ locale: query.get("locale") || "en", messages: { en, "zh-CN": zh } })
    function Fixture() {
      useTheme().setColorScheme(query.get("theme") || "light")
      const drafts = createProviderSetupDrafts()
      const [view, setView] = createSignal("providers")
      const [models, setModels] = createStore({ ...defaultSettingsState().models, model: "deepseek/chat" })
      const [layer, setLayer] = createSignal()
      const [repair, setRepair] = createSignal("")
      const saved = { ...models }
      const roles = MODEL_ROLES.map(role => ({ id: role.key === "model" ? "primary" : role.key.replace("_model", ""), field: role.key, label: role.key, summary: "", fallbackChain: role.key === "model" ? ["model"] : [role.key, "model"], usedBy: [], resolvedModel: { providerID: "deepseek", modelID: "chat", via: "model" } }))
      return <div class="settings-panel-frame"><button onClick={() => setView("models")}>Models page</button><button onClick={() => setView("providers")}>Providers page</button><button onClick={() => setModels("model", "missing/chat")}>Unavailable model</button>
        <Show when={view() === "providers"} fallback={<ModelsPanel models={models} savedModels={saved} roleVariant={{}} modelRoleSummaries={() => roles} providerModels={() => [{ providerId: "deepseek", providerName: "DeepSeek", id: "chat", name: "Test Chat", variantKeys: [] }]} popoverLayer={layer()} onModelChange={(key, value) => setModels(key, value)} onVariantChange={() => {}} onQuickSwitcherChange={preferences => setModels("quick_switcher", preferences)} onConnectProvider={setRepair} />}>
          <ProvidersPanel summaries={summaries()} authMethods={useGlobalSync().data.provider_auth} drafts={drafts} />
        </Show><output data-testid="models">{JSON.stringify(models)}</output><output data-testid="repair">{repair()}</output><div ref={setLayer} />
      </div>
    }
    render(() => <I18nProvider i18n={i18n}><ThemeProvider><DialogProvider><Fixture /></DialogProvider></ThemeProvider></I18nProvider>, document.getElementById("root"))
  `,
  )
  server = await createBrowserFixture({
    root: fixture,
    localized: true,
    aliases: [
      ...["global-sdk", "global-sync", "local", "platform", "locale"].map((name) => ({
        find: "@/context/" + name,
        replacement: path.join(fixture, "api.ts"),
      })),
      { find: "@/hooks/use-providers", replacement: path.join(fixture, "api.ts") },
      { find: "@ericsanchezok/synergy-ui/toast", replacement: path.join(fixture, "toast.ts") },
      { find: "@/", replacement: app + "/" },
    ],
  })
  url = server.url
  browser = await chromium.launch({ headless: true })
}, 100000)

beforeEach(async () => {
  errors.length = 0
  page = await browser.newPage()
  page.setDefaultTimeout(5000)
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 })
  try {
    await page.getByRole("heading", { name: "Providers", exact: true }).waitFor({ timeout: 30000 })
  } catch (error) {
    throw new Error(JSON.stringify({ errors, body: await page.locator("body").innerText() }), { cause: error })
  }
})
afterEach(async () => {
  await page?.close()
})
afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (fixture) await rm(fixture, { recursive: true, force: true })
})

test("provider discovery separates connected accounts and restores search and entry focus on return", async () => {
  expect(await page.locator(".providers-connected-account").count()).toBe(1)
  expect(await page.locator(".providers-directory").count()).toBe(0)
  await page.getByRole("button", { name: "Add model service", exact: true }).click()
  await page.getByRole("textbox", { name: "Search providers..." }).fill("Test Service")
  expect(await page.locator(".providers-row").count()).toBe(1)
  await page.locator(".providers-row").click()
  await page.getByLabel("Test Service API key", { exact: true }).waitFor()
  expect(await page.locator(".providers-directory").count()).toBe(0)
  expect(await page.getByRole("button", { name: "Connect", exact: true }).count()).toBe(1)
  await page.getByRole("button", { name: "Back to services", exact: true }).click()
  expect(await page.getByRole("textbox", { name: "Search providers..." }).inputValue()).toBe("Test Service")
  await page.waitForFunction(() => document.activeElement?.classList.contains("providers-row"))
  expect(errors).toEqual([])
})
test("credential failure remains in the flow and a failed refresh survives section changes without another write", async () => {
  await page.getByRole("button", { name: "Add model service", exact: true }).click()
  await page.locator(".providers-row").filter({ hasText: "Test Service" }).click()
  await page.getByLabel("Test Service API key", { exact: true }).fill("fixture-key")
  await page.evaluate(() => {
    ;(window as any).__failWrite = true
  })
  await page.getByRole("button", { name: "Connect", exact: true }).click()
  await page.getByText("Credential rejected", { exact: true }).waitFor()
  expect(await page.evaluate(() => (window as any).__resourceCalls.writes.length)).toBe(0)
  await page.evaluate(() => {
    ;(window as any).__failWrite = false
    ;(window as any).__failRead = true
  })
  await page.getByRole("button", { name: "Connect", exact: true }).click()
  await page
    .getByText("Refresh failed", { exact: true })
    .waitFor()
    .catch(async (error) => {
      throw new Error(JSON.stringify({ errors, body: await page.locator("body").innerText() }), { cause: error })
    })
  await page.getByRole("button", { name: "Models page", exact: true }).click()
  await page.getByRole("button", { name: "Providers page", exact: true }).click()
  await page.getByRole("button", { name: "Refresh connection", exact: true }).click()
  await page.getByText("Manage account", { exact: true }).waitFor()
  expect(await page.evaluate(() => (window as any).__resourceCalls.writes.length)).toBe(1)
  expect(errors).toEqual([])
})
test("adding an account waits for Connect and resumes the saved connection after a failed read", async () => {
  await page.locator(".providers-connected-account").click()
  await page.getByRole("button", { name: "Add another account", exact: true }).click()
  await page.getByLabel("Account remark (optional)", { exact: true }).fill("Work account")
  expect(await calls("creations")).toHaveLength(0)
  await page.locator(".provider-method-row").click()
  await page.getByLabel("DeepSeek API key", { exact: true }).fill("fixture-key")
  await flags({ __failRead: true })
  await page.getByRole("button", { name: "Connect", exact: true }).click()
  await page.getByText("Refresh failed", { exact: true }).waitFor()
  expect(await calls("writes")).toHaveLength(0)
  await page.getByRole("button", { name: "Connect", exact: true }).click()
  await page.getByText("Manage account", { exact: true }).waitFor()
  expect(await calls("creations")).toHaveLength(1)
  const writes = await calls("writes")
  expect(writes).toHaveLength(1)
  expect(writes[0].providerID).not.toBe("deepseek")
  expect(errors).toEqual([])
})

test("an interrupted additional account remains available to continue or remove", async () => {
  await page.locator(".providers-connected-account").click()
  await page.getByRole("button", { name: "Add another account", exact: true }).click()
  await page.getByLabel("Account remark (optional)", { exact: true }).fill("Work account")
  await page.locator(".provider-method-row").click()
  await page.getByLabel("DeepSeek API key", { exact: true }).fill("fixture-key")
  await flags({ __failWrite: true })
  await page.getByRole("button", { name: "Connect", exact: true }).click()
  await page.getByText("Credential rejected", { exact: true }).waitFor()
  await page.getByRole("button", { name: "Back to accounts", exact: true }).click()
  await page.locator(".providers-connected-account").filter({ hasText: "Work account" }).click()
  await page.getByLabel("Work account API key", { exact: true }).waitFor()
  await page.getByText("Manage account", { exact: true }).click()
  await page.getByRole("button", { name: "Remove account", exact: true }).waitFor()
  expect(errors).toEqual([])
})

test("model list status is neutral until an actual refresh failure and keeps usable models", async () => {
  await page.locator(".providers-connected-account").click()
  expect(await page.locator(".providers-catalog-warning").count()).toBe(0)
  expect(await page.locator(".providers-catalog-status time").getAttribute("datetime")).toBe("2026-10-03T12:00:00.000Z")
  await flags({ __catalogFailure: true })
  await page.getByRole("button", { name: "Refresh list", exact: true }).click()
  await page.locator(".providers-catalog-warning").waitFor()
  expect(await page.getByText("You can keep using the existing models.", { exact: true }).count()).toBe(1)
  expect(await page.locator(".provider-flow").count()).toBe(0)
  await flags({ __catalogFailure: false })
  await page.getByRole("button", { name: "Refresh list", exact: true }).click()
  await page.waitForFunction(() => !document.querySelector(".providers-catalog-warning"))
  expect(errors).toEqual([])
})

test("draft inputs survive a section change and cancel clears the pending setup", async () => {
  await page.locator(".providers-connected-account").click()
  await page.getByRole("button", { name: "Add another account", exact: true }).click()
  await page.getByLabel("Account remark (optional)", { exact: true }).fill("Work account")
  await page.locator(".provider-method-row").click()
  await page.getByLabel("DeepSeek API key", { exact: true }).fill("fixture-key")
  await page.getByRole("button", { name: "Models page", exact: true }).click()
  await page.getByRole("button", { name: "Providers page", exact: true }).click()
  expect(await page.getByLabel("Account remark (optional)", { exact: true }).inputValue()).toBe("Work account")
  await page.locator(".provider-method-row").click()
  expect(await page.getByLabel("DeepSeek API key", { exact: true }).inputValue()).toBe("fixture-key")
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await page.getByRole("button", { name: "Add another account", exact: true }).click()
  expect(await page.getByLabel("Account remark (optional)", { exact: true }).inputValue()).toBe("")
  await page.locator(".provider-method-row").click()
  expect(await page.getByLabel("DeepSeek API key", { exact: true }).inputValue()).toBe("")
  expect(await calls("creations")).toHaveLength(0)
  expect(errors).toEqual([])
})

test("a lost creation response is recovered using the same account identity", async () => {
  await page.locator(".providers-connected-account").click()
  await page.getByRole("button", { name: "Add another account", exact: true }).click()
  await page.locator(".provider-method-row").click()
  await page.getByLabel("DeepSeek API key", { exact: true }).fill("fixture-key")
  await flags({ __loseCreateResponse: true })
  await page.getByRole("button", { name: "Connect", exact: true }).evaluate((button) => {
    ;(button as HTMLButtonElement).click()
    ;(button as HTMLButtonElement).click()
  })
  await page.getByText("Manage account", { exact: true }).waitFor()
  expect(await calls("creations")).toHaveLength(1)
  expect(await calls("writes")).toHaveLength(1)
  expect((await calls("creations"))[0].id).toBe((await calls("writes"))[0].providerID)
  expect(errors).toEqual([])
})

test("first OAuth sign-in does not allocate a sibling and disposed callbacks cannot complete the view", async () => {
  await page.getByRole("button", { name: "Add model service", exact: true }).click()
  await page.locator(".providers-row").filter({ hasText: "OpenAI Codex" }).click()
  expect(await calls("creations")).toHaveLength(0)
  expect(await page.locator(".provider-method-title").allTextContents()).toEqual([
    "Sign in with ChatGPT",
    "Use Codex CLI sign-in on this device",
  ])
  await page.locator(".provider-method-row").first().click()
  await page.getByText("Waiting for authorization", { exact: false }).waitFor()
  const authorizations = await page.evaluate(() => (window as unknown as FixtureWindow).__resourceCalls.authorizations)
  expect(authorizations.map((item) => item.providerID)).toEqual(["openai-codex"])
  await page.getByRole("button", { name: "Models page", exact: true }).click()
  await page.evaluate(() => (window as unknown as FixtureWindow).__finishOAuth())
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).__resourceCalls.toasts)).toHaveLength(0)
  expect(errors).toEqual([])
})

test("completed first sign-in clears its setup and additional OAuth targets a separate connection", async () => {
  await page.getByRole("button", { name: "Add model service", exact: true }).click()
  await page.locator(".providers-row").filter({ hasText: "OpenAI Codex" }).click()
  await page.locator(".provider-method-row").first().click()
  await page.getByText("Waiting for authorization", { exact: false }).waitFor()
  await page.evaluate(() => (window as unknown as FixtureWindow).__finishOAuth())
  await page.getByRole("button", { name: "Add another account", exact: true }).waitFor()
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).__resourceCalls.toasts)).toHaveLength(1)
  await page.getByRole("button", { name: "Add another account", exact: true }).click()
  await page.locator(".provider-method-row").first().click()
  await page.getByText("Waiting for authorization", { exact: false }).waitFor()
  const authorizations = await page.evaluate(() => (window as unknown as FixtureWindow).__resourceCalls.authorizations)
  expect(authorizations).toHaveLength(2)
  expect(authorizations[1].providerID).toBe((await calls("creations"))[0].id)
  expect(authorizations[1].providerID).not.toBe("openai-codex")
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await page.evaluate(() => (window as unknown as FixtureWindow).__finishOAuth())
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).__resourceCalls.toasts)).toHaveLength(1)
  expect(errors).toEqual([])
})

test("a late credential write does not complete a disposed connection view", async () => {
  await page.getByRole("button", { name: "Add model service", exact: true }).click()
  await page.locator(".providers-row").filter({ hasText: "Test Service" }).click()
  await page.getByLabel("Test Service API key", { exact: true }).fill("fixture-key")
  await flags({ __pauseWrite: true })
  await page.getByRole("button", { name: "Connect", exact: true }).click()
  await page.waitForFunction(() => typeof (window as unknown as FixtureWindow).__releaseWrite === "function")
  await page.getByRole("button", { name: "Models page", exact: true }).click()
  await page.evaluate(() => (window as unknown as FixtureWindow).__releaseWrite())
  await page.waitForFunction(() => (window as unknown as FixtureWindow).__resourceCalls.writes.length === 1)
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).__resourceCalls.toasts)).toHaveLength(0)
  expect(await calls("creations")).toHaveLength(0)
  expect(errors).toEqual([])
})

test("maintenance disclosure and setup cancellation work from the keyboard at narrow widths", async () => {
  await page.setViewportSize({ width: 375, height: 812 })
  for (const theme of ["light", "dark"]) {
    await page.goto(url + "?theme=" + theme)
    await page.locator(".providers-connected-account").click()
    const management = page.locator(".providers-management > summary")
    await management.focus()
    await management.press("Enter")
    expect(await page.getByRole("button", { name: "Update credentials", exact: true }).isVisible()).toBe(true)
    await management.press("Enter")
    expect(await page.getByRole("button", { name: "Update credentials", exact: true }).isVisible()).toBe(false)
    await page.getByRole("button", { name: "Add another account", exact: true }).click()
    await page.getByRole("button", { name: "Cancel", exact: true }).press("Enter")
    await page.waitForFunction(() => document.activeElement?.hasAttribute("data-add-provider-account"))
    expect(await page.locator(".providers-auth-warning").count()).toBe(0)
  }
  expect(errors).toEqual([])
})

test("primary model is prominent and all seven specialist assignments stay available", async () => {
  await page.getByRole("button", { name: "Models page", exact: true }).click()
  expect(await page.locator(".settings-model-row").count()).toBe(1)
  await page.locator("summary").click()
  await page.waitForFunction(() => document.querySelectorAll(".settings-model-row").length === 8)
  expect(await page.locator(".settings-model-row").count()).toBe(8)
  expect(errors).toEqual([])
})
test("automatic and fixed model intent is explicit and Escape restores picker focus", async () => {
  await page.getByRole("button", { name: "Models page", exact: true }).click()
  const trigger = page.getByRole("button", { name: /^Default Model: (Fixed model|Automatic),/ })
  await trigger.click()
  const search = page.getByRole("textbox", { name: "Search models", exact: true }).last()
  await search.fill("Automatic")
  await search.press("Enter")
  expect(JSON.parse((await page.getByTestId("models").textContent())!).model).toBe("")
  await trigger.click()
  await page.keyboard.press("Escape")
  await page.waitForFunction(() =>
    document.activeElement?.getAttribute("aria-label")?.startsWith("Default Model: Automatic,"),
  )
  expect(errors).toEqual([])
})
test("quick model switches include model names and leave the session and role untouched", async () => {
  await page.getByRole("button", { name: "Models page", exact: true }).click()
  await page.getByRole("switch", { name: "Include Test Chat in quick switcher", exact: true }).press("Space")
  const model = JSON.parse((await page.getByTestId("models").textContent())!)
  expect(model.model).toBe("deepseek/chat")
  expect(model.quick_switcher).toEqual([{ providerID: "deepseek", modelID: "chat", state: "remove" }])
  expect(
    await page.evaluate(() => (window as unknown as { __sessionChanged?: boolean }).__sessionChanged),
  ).toBeUndefined()
})
test("quick model management updates when the full catalog arrives without search input", async () => {
  await page.getByRole("button", { name: "Models page", exact: true }).click()
  await page.getByRole("switch", { name: "Include Test Chat in quick switcher", exact: true }).waitFor()
  const search = page.getByRole("textbox", { name: "Search models", exact: true })
  expect(await search.inputValue()).toBe("")

  await page.evaluate(() => (window as unknown as { __publishModelCatalog(): void }).__publishModelCatalog())

  const added = page.getByRole("switch", { name: "Include Test New Model in quick switcher", exact: true })
  await added.waitFor()
  expect(await search.inputValue()).toBe("")
  await added.press("Space")
  const models = JSON.parse((await page.getByTestId("models").textContent())!)
  expect(models.model).toBe("deepseek/chat")
  expect(models.quick_switcher).toEqual([{ providerID: "deepseek", modelID: "new-model", state: "add" }])
  expect(errors).toEqual([])
})
test("unavailable selections are preserved with a service repair entry", async () => {
  await page.getByRole("button", { name: "Models page", exact: true }).click()
  await page.getByRole("button", { name: "Unavailable model", exact: true }).click()
  await page.getByText("This model is unavailable.", { exact: false }).waitFor()
  await page.getByRole("button", { name: "Check service", exact: true }).click()
  expect(await page.getByTestId("repair").textContent()).toBe("missing")
  expect(JSON.parse((await page.getByTestId("models").textContent())!).model).toBe("missing/chat")
})

test("a completed credential import survives section changes and retries only account refresh", async () => {
  await page.evaluate(() => {
    ;(window as unknown as { __useImport(): void; __failRead: boolean }).__useImport()
    ;(window as unknown as { __failRead: boolean }).__failRead = true
  })
  await page.getByRole("button", { name: "Add model service", exact: true }).click()
  await page.locator(".providers-row").filter({ hasText: "Test Service" }).click()
  await page.getByRole("button", { name: "Refresh connection", exact: true }).waitFor()
  await page.getByRole("button", { name: "Models page", exact: true }).click()
  await page.getByRole("button", { name: "Providers page", exact: true }).click()
  await page.getByRole("button", { name: "Refresh connection", exact: true }).waitFor()
  expect(await calls("writes")).toHaveLength(1)
  await page.getByRole("button", { name: "Refresh connection", exact: true }).click()
  await page.getByText("Manage account", { exact: true }).waitFor()
  expect(
    await page.evaluate(
      () => (window as unknown as { __resourceCalls: { writes: unknown[] } }).__resourceCalls.writes.length,
    ),
  ).toBe(1)
  expect(errors).toEqual([])
})
