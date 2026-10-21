import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import type { ProviderConnectionCustomInput, ProviderConnectionUpdateInput } from "@ericsanchezok/synergy-sdk/client"
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
  __failCredentials?: boolean
  __catalogFailure?: boolean
  __loseCreateResponse?: boolean
  __pauseWrite?: boolean
  __pauseUpdate?: boolean
}
interface FixtureWindow extends Window, FixtureFlags {
  __resourceCalls: {
    writes: { providerID: string; auth?: { type: "api"; key: string } }[]
    credentialAttempts: { providerID: string }[]
    creations: { id: string }[]
    customCreations: { providerConnectionCustomInput: ProviderConnectionCustomInput }[]
    authorizations: { providerID: string }[]
    refreshes: number
    toasts: unknown[]
    updates: {
      providerID: string
      providerConnectionUpdateInput: ProviderConnectionUpdateInput
    }[]
    removals: { providerID: string }[]
  }
  __finishOAuth(): void
  __releaseWrite(): void
  __releaseUpdate(): void
  __disableDefault(): void
  __configureFirstAccount(): void
  __configureCustomAccount(): void
}
function calls<Key extends keyof FixtureWindow["__resourceCalls"]>(key: Key) {
  return page.evaluate((key) => (window as unknown as FixtureWindow).__resourceCalls[key], key)
}
const flags = (value: FixtureFlags) =>
  page.evaluate((value) => {
    Object.assign(window, value)
  }, value)

async function addAnotherAccount(name = "DeepSeek") {
  await page
    .locator(".providers-connected-account")
    .filter({ hasText: name })
    .getByRole("button", { name: "Account actions", exact: true })
    .click()
  await page.getByRole("menuitem", { name: "Add another account", exact: true }).click()
}

async function fillCustomProviderIdentity() {
  await page.getByLabel("Display name", { exact: true }).first().fill("Research gateway")
  await page.getByLabel("Provider ID", { exact: true }).fill("research-gateway")
  await page.getByLabel("API base URL", { exact: true }).fill("https://gateway.example.com/v1")
  await page.getByLabel("API key", { exact: true }).fill("custom-fixture-key")
  const model = page.getByRole("group", { name: "Model 1", exact: true })
  await model.getByLabel("Model ID", { exact: true }).fill("reasoner")
  await model.getByLabel("Display name", { exact: true }).fill("Research model")
}

beforeAll(async () => {
  fixture = await mkdtemp(path.join(import.meta.dir, ".settings-resources-"))
  const app = path.resolve(import.meta.dir, "../../../src")
  await Bun.write(
    path.join(fixture, "index.html"),
    '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
  )
  await Bun.write(
    path.join(fixture, "api.ts"),
    `
    import { createStore } from "solid-js/store"
    import { createIntlFormatter } from "/@fs/${app}/context/locale/formatter.ts"
    export function useLocale() { return { fmt: createIntlFormatter(() => new URLSearchParams(location.search).get("locale") || "en") } }
    const capabilities = { reasoning: true, input: { text: true, image: false, pdf: false, video: false, audio: false }, output: { text: true, audio: false } }
    const model = { id: "chat", name: "Test Chat", capabilities, cost: { input: 1, output: 1 }, variants: {} }
    const base = (id, connected) => ({ id, name: id === "deepseek" ? "DeepSeek" : id === "openai-codex" ? "OpenAI Codex" : "Test Service", profile: { name: id === "deepseek" ? "DeepSeek" : id === "openai-codex" ? "OpenAI Codex" : "Test Service" }, profileID: id, catalogProviderID: id, configured: connected, enabled: true, removable: false, canCreateSibling: true, connected, modelCount: 1, models: { chat: model }, catalog: { source: "live", refreshing: false, lastVerifiedAt: 1791028800000 }, health: { status: connected ? "connected" : "unconfigured", source: "api" } })
    const [data, setData] = createStore({ provider: { all: [base("deepseek", true), base("test-service", false), base("openai-codex", false)], connected: ["deepseek"], profiles: {}, default: { deepseek: "chat" } }, provider_auth: { deepseek: [{ type: "api", label: "API key" }], "test-service": [{ type: "api", label: "API key" }], "openai-codex": [{ type: "oauth", label: "Login with ChatGPT" }, { type: "import", label: "Import Codex CLI credentials" }] } })
    setData("provider", "connections", Object.fromEntries(data.provider.all.map(item => [item.id, item])))
    const writes = []; const credentialAttempts = []; const creations = []; const customCreations = []; const authorizations = []; const toasts = []; const updates = []; const removals = []; const authenticated = new Set(["deepseek"])
    window.__resourceCalls = { writes, credentialAttempts, creations, customCreations, authorizations, toasts, updates, removals, refreshes: 0 }
    function publishCustom(account) {
      const models = Object.fromEntries(account.models.map(spec => [spec.id, { ...model, id: spec.id, name: spec.name || spec.id, capabilities: { ...capabilities, toolcall: spec.toolCall, reasoning: spec.reasoning, input: { ...capabilities.input, image: spec.image } }, limit: { context: spec.context, output: spec.output } }]))
      const provider = { ...account, models, modelCount: account.models.length, health: { status: account.enabled ? "unconfigured" : "disabled", source: "api" } }
      if (data.provider.connections[account.id]) setData("provider", "all", item => item.id === account.id, provider)
      else setData("provider", "all", [...data.provider.all, provider])
      setData("provider", "connections", account.id, account)
    }
    window.__useImport = () => setData("provider_auth", "test-service", [{ type: "import", label: "Import credentials" }])
    window.__configureFirstAccount = () => { const value = { name: "Configured key", endpoint: "https://configured.example.com/v1", enabled: false, configured: true }; setData("provider", "all", item => item.id === "test-service", value); setData("provider", "connections", "test-service", value) }
    window.__configureCustomAccount = () => {
      const id = "lab-gateway"
      authenticated.add(id)
      publishCustom({ id, name: "Lab gateway", profileID: id, catalogProviderID: id, endpoint: "https://lab.example.com/v1", enabled: false, configured: true, removable: true, canCreateSibling: false, protocol: "openai-completions", models: [
        { id: "chat", name: "Lab chat", context: 131072, output: 16384, toolCall: true, image: false, reasoning: false },
        { id: "vision", name: "Lab vision", context: 262144, output: 8192, toolCall: true, image: true, reasoning: false },
      ] })
    }
    window.__disableDefault = () => { authenticated.delete("deepseek"); setData("provider", "connected", []); setData("provider", "all", item => item.id === "deepseek", { enabled: false, health: { status: "disabled", source: "api" } }); setData("provider", "connections", "deepseek", "enabled", false) }
    window.__publishModelCatalog = () => setData("provider", "all", 0, "models", {
      chat: model,
      "new-model": { ...model, id: "new-model", name: "Test New Model" },
    })
    export const summaries = () => data.provider.all.map(provider => ({ ...provider, ...(data.provider.connections[provider.id]?.protocol ? data.provider.connections[provider.id] : {}), connected: data.provider.connected.includes(provider.id) }))
    export function useGlobalSync() { return { data, refreshProviders: async () => { window.__resourceCalls.refreshes++; if (window.__failRead) { window.__failRead = false; throw new Error("Refresh failed") } setData("provider", "connected", [...authenticated].filter(id => data.provider.connections[id]?.enabled !== false)); setData("provider", "all", item => ({ ...item, health: { ...item.health, status: item.enabled === false ? "disabled" : authenticated.has(item.id) ? "connected" : "unconfigured" } })) } } }
    export function useGlobalSDK() { return { client: {
      auth: { set: async input => { credentialAttempts.push(input); if (window.__pauseWrite) await new Promise(resolve => { window.__releaseWrite = resolve }); if (window.__failWrite || window.__failCredentials) throw { data: { message: "Credential rejected" } }; writes.push(input); authenticated.add(input.providerID) } },
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
        createCustom: async input => { customCreations.push(input); const account = { ...input.providerConnectionCustomInput, profileID: input.providerConnectionCustomInput.id, catalogProviderID: input.providerConnectionCustomInput.id, enabled: true, configured: true, removable: true, canCreateSibling: false }; publishCustom(account); return { data: account } },
        update: async input => { if (window.__pauseUpdate) await new Promise(resolve => { window.__releaseUpdate = resolve }); if (window.__failWrite) throw { data: { message: "Account update rejected" } }; updates.push(input); const account = { ...data.provider.connections[input.providerID], ...input.providerConnectionUpdateInput }; if (account.protocol) publishCustom(account); else { setData("provider", "all", item => item.id === input.providerID, account); setData("provider", "connections", input.providerID, account) } return { data: account } },
        remove: async input => { removals.push(input); authenticated.delete(input.providerID); setData("provider", "all", data.provider.all.filter(item => item.id !== input.providerID)); } }, disconnect: async () => {} }
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
      return <div class="settings-panel-frame"><button onClick={() => setView("models")}>Models page</button><button onClick={() => setView("providers")}>Providers page</button><button onClick={() => setModels("model", "missing/chat")}>Unavailable model</button><div class="settings-panel-content">
        <Show when={view() === "providers"} fallback={<ModelsPanel models={models} savedModels={saved} roleVariant={{}} modelRoleSummaries={() => roles} providerModels={() => [{ providerId: "deepseek", providerName: "DeepSeek", id: "chat", name: "Test Chat", variantKeys: [] }]} popoverLayer={layer()} onModelChange={(key, value) => setModels(key, value)} onVariantChange={() => {}} onQuickSwitcherChange={preferences => setModels("quick_switcher", preferences)} onConnectProvider={setRepair} />}>
          <ProvidersPanel summaries={summaries()} authMethods={useGlobalSync().data.provider_auth} drafts={drafts} />
        </Show><output hidden data-testid="models">{JSON.stringify(models)}</output><output hidden data-testid="repair">{repair()}</output><div ref={setLayer} />
      </div></div>
    }
    render(() => <I18nProvider i18n={i18n}><ThemeProvider><DialogProvider><Fixture /></DialogProvider></ThemeProvider></I18nProvider>, document.getElementById("root"))
  `,
  )
  server = await createBrowserFixture({
    root: fixture,
    styled: true,
    localized: true,
    aliases: [
      ...["global-sdk", "global-sync", "local", "platform", "locale"].map((name) => ({
        find: "@/context/" + name,
        replacement: path.join(fixture, "api.ts"),
      })),
      { find: "@/hooks/use-providers", replacement: path.join(fixture, "api.ts") },
      { find: "@ericsanchezok/synergy-ui/toast", replacement: path.join(fixture, "toast.ts") },
      {
        find: "@ericsanchezok/synergy-plugin/theme",
        replacement: path.resolve(app, "../../../packages/plugin/src/theme/index.ts"),
      },
      {
        find: "@ericsanchezok/synergy-plugin/icons",
        replacement: path.resolve(app, "../../../packages/plugin/src/icons.ts"),
      },
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

test("custom API fields and actions match the protocol surface and keep routine copy aligned", async () => {
  await page.setViewportSize({ width: 1600, height: 1100 })
  await page.getByRole("button", { name: "Add custom model API", exact: true }).click()
  const form = page.locator(".custom-provider-form")
  const name = form.getByLabel("Display name", { exact: true }).first()
  const id = form.getByLabel("Provider ID", { exact: true })
  const endpoint = form.getByLabel("API base URL", { exact: true })
  const protocol = form.getByRole("button", { name: "API protocol: OpenAI Chat Completions", exact: true })
  const background = await protocol.evaluate((element) => getComputedStyle(element).backgroundColor)
  for (const control of await form.locator('[data-slot="input-wrapper"], [data-component="button"]').all()) {
    const style = await control.evaluate((element) => {
      const style = getComputedStyle(element)
      return { background: style.backgroundColor, border: style.borderTopWidth, shadow: style.boxShadow }
    })
    expect(style).toEqual({ background, border: "0px", shadow: "none" })
  }
  const first = page.getByRole("group", { name: "Model 1", exact: true })
  expect(await form.locator("p:visible").count()).toBe(0)
  expect(await form.locator('[data-slot="input-description"]:visible').count()).toBe(0)
  expect(await name.isVisible()).toBe(true)
  expect(await id.isVisible()).toBe(true)
  expect(await endpoint.getAttribute("placeholder")).toBe("https://gateway.example.com/v1")
  const pair = async (left: typeof name, right: typeof name) => {
    const a = await left.boundingBox()
    const b = await right.boundingBox()
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(Math.abs(a!.y - b!.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(a!.height - b!.height)).toBeLessThanOrEqual(2)
  }
  await pair(name, id)
  await pair(endpoint, protocol)
  await pair(
    first.getByLabel("Context window (tokens)", { exact: true }),
    first.getByLabel("Maximum output (tokens)", { exact: true }),
  )
  const title = await first.getByText("Model 1", { exact: true }).last().boundingBox()
  const remove = await first.getByRole("button", { name: "Remove model 1", exact: true }).boundingBox()
  expect(title).not.toBeNull()
  expect(remove).not.toBeNull()
  expect(Math.abs(title!.y + title!.height / 2 - remove!.y - remove!.height / 2)).toBeLessThanOrEqual(1)
  await page.setViewportSize({ width: 375, height: 900 })
  const narrowEndpoint = await endpoint.boundingBox()
  const narrowProtocol = await protocol.boundingBox()
  expect(narrowProtocol!.y).toBeGreaterThanOrEqual(narrowEndpoint!.y + narrowEndpoint!.height)
  expect(Math.abs(narrowProtocol!.x - narrowEndpoint!.x)).toBeLessThanOrEqual(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await form.getByRole("button", { name: "Create provider", exact: true }).click()
  await form.getByRole("alert").waitFor()
  expect(await calls("customCreations")).toHaveLength(0)
  await name.fill("Unsaved gateway")
  await page.getByRole("button", { name: "Back to accounts", exact: true }).click()
  const confirmation = page.getByRole("dialog")
  await confirmation.waitFor()
  for (const button of await confirmation.locator('[data-component="button"]').all()) {
    expect(await button.evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe("0px")
    expect(await button.evaluate((element) => getComputedStyle(element).boxShadow)).toBe("none")
    expect(await button.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(background)
  }
  await page.keyboard.press("Escape")
  expect(await name.inputValue()).toBe("Unsaved gateway")
  expect(errors).toEqual([])
})

test("peer provider entries separate known service setup from custom protocol, limits and credentials", async () => {
  const thirdParty = page.getByRole("button", { name: "Add third-party provider", exact: true })
  const custom = page.getByRole("button", { name: "Add custom model API", exact: true })
  expect(await thirdParty.isVisible()).toBe(true)
  expect(await custom.isVisible()).toBe(true)
  await thirdParty.click()
  await page.getByRole("textbox", { name: "Search providers...", exact: true }).waitFor()
  expect(await page.getByLabel("Provider ID", { exact: true }).count()).toBe(0)
  await page.locator(".providers-row").filter({ hasText: "Test Service" }).click()
  await page.getByLabel("Test Service API key", { exact: true }).waitFor()
  expect(await page.getByLabel("API base URL", { exact: true }).count()).toBe(0)
  expect(await page.getByRole("button", { name: "Create provider", exact: true }).count()).toBe(0)
  await page.getByRole("button", { name: "Back to services", exact: true }).click()
  await page.getByRole("button", { name: "Back to accounts", exact: true }).click()
  await custom.click()
  await page.getByRole("heading", { name: "Custom model API", exact: true }).waitFor()
  expect(await page.getByRole("textbox", { name: "Search providers...", exact: true }).count()).toBe(0)
  expect(await page.getByLabel("Account remark (optional)", { exact: true }).count()).toBe(0)
  await fillCustomProviderIdentity()
  await page.getByRole("button", { name: "API protocol: OpenAI Chat Completions", exact: true }).click()
  await page.getByRole("option", { name: "OpenAI Responses", exact: true }).click()
  const first = page.getByRole("group", { name: "Model 1", exact: true })
  expect(await first.getByLabel("Context window (tokens)", { exact: true }).inputValue()).toBe("")
  expect(await first.getByLabel("Maximum output (tokens)", { exact: true }).inputValue()).toBe("")
  await page.getByRole("button", { name: "Create provider", exact: true }).click()
  await page
    .getByRole("alert")
    .getByText("Enter positive whole numbers for the model's context and output limits.", { exact: true })
    .waitFor()
  expect(await calls("customCreations")).toHaveLength(0)
  expect(await calls("writes")).toHaveLength(0)
  await first.getByLabel("Context window (tokens)", { exact: true }).fill("1048576")
  await first.getByLabel("Maximum output (tokens)", { exact: true }).fill("131072")
  await first.getByRole("switch", { name: "Tool calling", exact: true }).press("Space")
  await first.getByRole("switch", { name: "Image input", exact: true }).press("Space")
  await first.getByRole("switch", { name: "Reasoning", exact: true }).press("Space")
  await page.getByRole("button", { name: "Add model", exact: true }).click()
  const second = page.getByRole("group", { name: "Model 2", exact: true })
  await second.getByLabel("Model ID", { exact: true }).fill("plain-chat")
  await second.getByLabel("Context window (tokens)", { exact: true }).fill("32768")
  await second.getByLabel("Maximum output (tokens)", { exact: true }).fill("4096")
  await page.getByRole("button", { name: "Create provider", exact: true }).click()
  await page.getByRole("button", { name: "Save changes", exact: true }).waitFor()
  expect(await page.getByRole("button", { name: "Save changes", exact: true }).isDisabled()).toBe(true)
  expect(await calls("customCreations")).toEqual([
    {
      providerConnectionCustomInput: {
        id: "research-gateway",
        name: "Research gateway",
        endpoint: "https://gateway.example.com/v1",
        protocol: "openai-responses",
        models: [
          {
            id: "reasoner",
            name: "Research model",
            context: 1048576,
            output: 131072,
            toolCall: false,
            image: true,
            reasoning: true,
          },
          { id: "plain-chat", context: 32768, output: 4096, toolCall: true, image: false, reasoning: false },
        ],
      },
    },
  ])
  expect(await calls("writes")).toEqual([
    { providerID: "research-gateway", auth: { type: "api", key: "custom-fixture-key" } },
  ])
  expect(await calls("creations")).toHaveLength(0)
  expect(await calls("updates")).toHaveLength(0)
  expect(await page.getByLabel("API key", { exact: true }).inputValue()).toBe("")
  expect(await page.getByRole("button", { name: "API protocol: OpenAI Responses", exact: true }).isVisible()).toBe(true)
  await page.getByRole("button", { name: "Back to accounts", exact: true }).click()
  const account = page.locator(".providers-connected-account").filter({ hasText: "Research gateway" })
  await account.waitFor()
  expect(await account.innerText()).not.toContain("Test Service")
  await account.getByRole("button", { name: "Account actions", exact: true }).click()
  expect(await page.getByRole("menuitem", { name: "Add another account", exact: true }).count()).toBe(0)
  expect(await page.getByRole("menuitem", { name: "Remove account", exact: true }).isVisible()).toBe(true)
  await page.keyboard.press("Escape")
  expect(errors).toEqual([])
})

test("custom edits survive section changes and the visible enabled switch persists a disabled account", async () => {
  await page.evaluate(() => (window as unknown as FixtureWindow).__configureCustomAccount())
  const account = page.locator(".providers-connected-account").filter({ hasText: "Lab gateway" })
  await account.getByRole("button", { name: "Edit account", exact: true }).click()
  const enabled = page.getByRole("switch", { name: "Enabled", exact: true })
  const first = page.getByRole("group", { name: "Model 1", exact: true })
  const second = page.getByRole("group", { name: "Model 2", exact: true })
  expect(await page.getByLabel("Provider ID", { exact: true }).isDisabled()).toBe(true)
  expect(await page.getByRole("button", { name: "Save changes", exact: true }).isDisabled()).toBe(true)
  expect(await page.getByText("Enabled", { exact: true }).isVisible()).toBe(true)
  expect(await enabled.isChecked()).toBe(false)
  await page.getByLabel("Display name", { exact: true }).first().fill("Work gateway")
  await page.getByLabel("API base URL", { exact: true }).fill("https://work.example.com/api")
  await page.getByRole("button", { name: "API protocol: OpenAI Chat Completions", exact: true }).click()
  await page.getByRole("option", { name: "Anthropic Messages", exact: true }).click()
  await first.getByLabel("Display name", { exact: true }).fill("Lab reasoning")
  await first.getByLabel("Context window (tokens)", { exact: true }).fill("1048576")
  await first.getByLabel("Maximum output (tokens)", { exact: true }).fill("131072")
  await first.getByRole("switch", { name: "Reasoning", exact: true }).press("Space")
  await enabled.press("Space")
  await page.getByRole("button", { name: "Models page", exact: true }).click()
  await page.getByRole("button", { name: "Providers page", exact: true }).click()
  expect(await page.getByLabel("Display name", { exact: true }).first().inputValue()).toBe("Work gateway")
  expect(await page.getByLabel("Provider ID", { exact: true }).inputValue()).toBe("lab-gateway")
  expect(await page.getByLabel("API base URL", { exact: true }).inputValue()).toBe("https://work.example.com/api")
  expect(await page.getByRole("button", { name: "API protocol: Anthropic Messages", exact: true }).isVisible()).toBe(
    true,
  )
  expect(await first.getByLabel("Display name", { exact: true }).inputValue()).toBe("Lab reasoning")
  expect(await first.getByLabel("Context window (tokens)", { exact: true }).inputValue()).toBe("1048576")
  expect(await first.getByLabel("Maximum output (tokens)", { exact: true }).inputValue()).toBe("131072")
  expect(await first.getByRole("switch", { name: "Reasoning", exact: true }).isChecked()).toBe(true)
  expect(await second.getByLabel("Model ID", { exact: true }).inputValue()).toBe("vision")
  expect(await second.getByRole("switch", { name: "Image input", exact: true }).isChecked()).toBe(true)
  expect(await enabled.isChecked()).toBe(true)
  expect(await calls("updates")).toHaveLength(0)
  await page.getByRole("button", { name: "Back to accounts", exact: true }).click()
  await page.getByRole("dialog", { name: "Discard unsaved changes?", exact: true }).waitFor()
  await page.getByRole("button", { name: "Keep Editing", exact: true }).click()
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
  await page.locator(".custom-provider-footer button[type=submit]:disabled").waitFor()
  expect(await calls("updates")).toEqual([
    {
      providerID: "lab-gateway",
      providerConnectionUpdateInput: {
        name: "Work gateway",
        endpoint: "https://work.example.com/api",
        protocol: "anthropic-messages",
        enabled: true,
        models: [
          {
            id: "chat",
            name: "Lab reasoning",
            context: 1048576,
            output: 131072,
            toolCall: true,
            image: false,
            reasoning: true,
          },
          {
            id: "vision",
            name: "Lab vision",
            context: 262144,
            output: 8192,
            toolCall: true,
            image: true,
            reasoning: false,
          },
        ],
      },
    },
  ])
  expect(await calls("writes")).toHaveLength(0)
  expect(await calls("customCreations")).toHaveLength(0)
  expect(await calls("creations")).toHaveLength(0)
  await page.getByRole("button", { name: "Back to accounts", exact: true }).click()
  await page.getByRole("button", { name: "Add custom model API", exact: true }).waitFor()
  expect(await page.getByRole("dialog").count()).toBe(0)
  await page
    .locator(".providers-connected-account")
    .filter({ hasText: "Work gateway" })
    .getByRole("button", { name: "Edit account", exact: true })
    .click()
  expect(await enabled.isChecked()).toBe(true)
  expect(await first.getByLabel("Context window (tokens)", { exact: true }).inputValue()).toBe("1048576")
  expect(await second.getByLabel("Maximum output (tokens)", { exact: true }).inputValue()).toBe("8192")
  expect(await page.getByRole("button", { name: "API protocol: Anthropic Messages", exact: true }).isVisible()).toBe(
    true,
  )
  expect(await page.getByRole("button", { name: "Save changes", exact: true }).isDisabled()).toBe(true)
  expect(errors).toEqual([])
})

for (const editing of [false, true]) {
  test(`saved custom ${editing ? "edits" : "creation"} retry credentials and reads without repeating config writes`, async () => {
    if (editing) {
      await page.evaluate(() => (window as unknown as FixtureWindow).__configureCustomAccount())
      await page
        .locator(".providers-connected-account")
        .filter({ hasText: "Lab gateway" })
        .getByRole("button", { name: "Edit account", exact: true })
        .click()
      await page.getByLabel("Display name", { exact: true }).first().fill("Research gateway")
      await page.getByLabel("API key", { exact: true }).fill("custom-fixture-key")
    } else {
      await page.getByRole("button", { name: "Add custom model API", exact: true }).click()
      await fillCustomProviderIdentity()
      await page.getByLabel("Context window (tokens)", { exact: true }).fill("1048576")
      await page.getByLabel("Maximum output (tokens)", { exact: true }).fill("131072")
    }
    const configWrites = editing ? "updates" : "customCreations"
    const providerID = editing ? "lab-gateway" : "research-gateway"
    await flags({ __failCredentials: true })
    await page.getByRole("button", { name: editing ? "Save changes" : "Create provider", exact: true }).click()
    await page.getByRole("alert").getByText("Credential rejected", { exact: true }).waitFor()
    await page
      .getByRole("status")
      .getByText("Provider configuration saved. Retry to finish storing credentials or refreshing the list.", {
        exact: true,
      })
      .waitFor()
    expect(await calls(configWrites)).toHaveLength(1)
    expect(await calls("credentialAttempts")).toHaveLength(1)
    expect(await calls("writes")).toHaveLength(0)
    expect(await calls("refreshes")).toBe(0)
    expect(await page.getByLabel("API key", { exact: true }).inputValue()).toBe("custom-fixture-key")
    expect(await page.getByLabel("API base URL", { exact: true }).isDisabled()).toBe(true)
    await page.getByRole("button", { name: "Models page", exact: true }).click()
    await page.getByRole("button", { name: "Providers page", exact: true }).click()
    await page.getByRole("button", { name: "Continue setup", exact: true }).waitFor()
    expect(await page.getByLabel("API key", { exact: true }).inputValue()).toBe("custom-fixture-key")
    expect(await page.getByLabel("Display name", { exact: true }).first().isDisabled()).toBe(true)
    await flags({ __failCredentials: false, __failRead: true })
    await page.getByRole("button", { name: "Continue setup", exact: true }).click()
    await page.getByRole("alert").getByText("Refresh failed", { exact: true }).waitFor()
    expect(await calls(configWrites)).toHaveLength(1)
    expect(await calls("credentialAttempts")).toHaveLength(2)
    expect(await calls("writes")).toEqual([{ providerID, auth: { type: "api", key: "custom-fixture-key" } }])
    expect(await calls("refreshes")).toBe(1)
    expect(await page.getByLabel("API key", { exact: true }).inputValue()).toBe("")
    expect(await page.getByLabel("API key", { exact: true }).isDisabled()).toBe(true)
    await page.getByRole("button", { name: "Models page", exact: true }).click()
    await page.getByRole("button", { name: "Providers page", exact: true }).click()
    await page.getByRole("button", { name: "Continue setup", exact: true }).click()
    await page.locator(".custom-provider-footer button[type=submit]:disabled").waitFor()
    expect(await page.getByRole("button", { name: "Save changes", exact: true }).isDisabled()).toBe(true)
    expect(await page.getByRole("button", { name: "Continue setup", exact: true }).count()).toBe(0)
    expect(await page.getByRole("alert").count()).toBe(0)
    expect(await calls(configWrites)).toHaveLength(1)
    expect(await calls(editing ? "customCreations" : "updates")).toHaveLength(0)
    expect(await calls("creations")).toHaveLength(0)
    expect(await calls("credentialAttempts")).toHaveLength(2)
    expect(await calls("writes")).toHaveLength(1)
    expect(await calls("refreshes")).toBe(2)
    await page.getByRole("button", { name: "Back to accounts", exact: true }).click()
    await page.getByRole("button", { name: "Add custom model API", exact: true }).waitFor()
    expect(await page.getByRole("dialog").count()).toBe(0)
    await page
      .locator(".providers-connected-account")
      .filter({ hasText: "Research gateway" })
      .getByRole("button", { name: "Edit account", exact: true })
      .click()
    expect(await page.getByLabel("Provider ID", { exact: true }).inputValue()).toBe(providerID)
    expect(await page.getByLabel("API key", { exact: true }).inputValue()).toBe("")
    expect(await page.getByRole("button", { name: "Save changes", exact: true }).isDisabled()).toBe(true)
    await page.getByRole("button", { name: "Back to accounts", exact: true }).click()
    await page.getByRole("button", { name: "Add custom model API", exact: true }).click()
    expect(await page.getByLabel("Provider ID", { exact: true }).inputValue()).toBe("")
    expect(await page.getByLabel("API key", { exact: true }).inputValue()).toBe("")
    expect(await page.getByRole("dialog").count()).toBe(0)
    expect(errors).toEqual([])
  })
}

test("default accounts open a focused editor and save an optional remark without changing identity", async () => {
  await page.locator(".providers-connected-account").getByRole("button", { name: "Edit account", exact: true }).click()
  const remark = page.getByLabel("Account remark (optional)", { exact: true })
  await remark.fill("Personal key")
  expect(await page.getByText("Manage account", { exact: true }).count()).toBe(0)
  expect(await page.getByRole("button", { name: "Add another account", exact: true }).count()).toBe(0)
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
  await page.getByRole("button", { name: "Back to accounts", exact: true }).click()
  await page.locator(".providers-connected-account").filter({ hasText: "Personal key" }).waitFor()
  expect(await calls("creations")).toHaveLength(0)
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).__resourceCalls.updates)).toEqual([
    { providerID: "deepseek", providerConnectionUpdateInput: { name: "Personal key" } },
  ])
  expect(errors).toEqual([])
})

test("account edits retain failed saves and retry a saved refresh without another update", async () => {
  await page.getByRole("button", { name: "Edit account", exact: true }).click()
  const remark = page.getByLabel("Account remark (optional)", { exact: true })
  await remark.fill("Work key")
  await flags({ __failWrite: true })
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
  await page.getByText("Account update rejected", { exact: true }).waitFor()
  expect(await remark.inputValue()).toBe("Work key")
  await flags({ __failWrite: false, __failRead: true })
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
  await page.getByRole("button", { name: "Refresh connection", exact: true }).waitFor()
  await page.getByRole("button", { name: "Models page", exact: true }).click()
  await page.getByRole("button", { name: "Providers page", exact: true }).click()
  await page.getByRole("button", { name: "Refresh connection", exact: true }).click()
  await page.getByRole("button", { name: "Save changes", exact: true }).waitFor()
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).__resourceCalls.updates.length)).toBe(1)
  await remark.fill("")
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
  await page.waitForFunction(() => (window as unknown as FixtureWindow).__resourceCalls.updates.length === 2)
  const updates = await page.evaluate(() => (window as unknown as FixtureWindow).__resourceCalls.updates)
  expect(updates.map((item) => item.providerID)).toEqual(["deepseek", "deepseek"])
  expect(updates[1].providerConnectionUpdateInput.name).toBe("DeepSeek")
  expect(errors).toEqual([])
})

test("credential replacement stays on the account and does not discard an unsaved remark", async () => {
  await page.getByRole("button", { name: "Edit account", exact: true }).click()
  const remark = page.getByLabel("Account remark (optional)", { exact: true })
  await remark.fill("Unsaved remark")
  await page.getByRole("button", { name: "Update credentials", exact: true }).click()
  await page.getByLabel("DeepSeek API key", { exact: true }).fill("replacement-key")
  await page.getByRole("button", { name: "Connect", exact: true }).click()
  await page.getByRole("button", { name: "Update credentials", exact: true }).waitFor()
  expect((await calls("writes")).map((item) => item.providerID)).toEqual(["deepseek"])
  expect(await calls("creations")).toHaveLength(0)
  expect(await remark.inputValue()).toBe("Unsaved remark")
  await page.getByRole("button", { name: "Back to accounts", exact: true }).click()
  await page.getByRole("button", { name: "Keep editing", exact: true }).click()
  expect(await remark.inputValue()).toBe("Unsaved remark")
  await page.getByRole("button", { name: "Back to accounts", exact: true }).click()
  await page.getByRole("button", { name: "Discard", exact: true }).click()
  await page.getByRole("button", { name: "Edit account", exact: true }).click()
  expect(await remark.inputValue()).toBe("")
  expect(errors).toEqual([])
})

test("choosing a connected service uses the same add flow and allocates a separate account", async () => {
  await page.getByRole("button", { name: "Add third-party provider", exact: true }).click()
  await page.locator(".providers-row").filter({ hasText: "DeepSeek" }).click()
  await page.getByLabel("Account remark (optional)", { exact: true }).fill("Work key")
  await page.getByLabel("DeepSeek API key", { exact: true }).fill("fixture-key")
  expect(await calls("creations")).toHaveLength(0)
  await page.getByRole("button", { name: "Connect", exact: true }).click()
  await page.getByRole("button", { name: "Save changes", exact: true }).waitFor()
  expect(await calls("creations")).toHaveLength(1)
  expect((await calls("writes"))[0].providerID).not.toBe("deepseek")
  await page.getByRole("button", { name: "Back to accounts", exact: true }).click()
  await page.getByRole("button", { name: "Add third-party provider", exact: true }).click()
  expect(await page.locator(".providers-row").filter({ hasText: "DeepSeek" }).count()).toBe(1)
  expect(errors).toEqual([])
})

test("adding another account from a disabled default never replaces its credentials", async () => {
  await page.evaluate(() => (window as unknown as FixtureWindow).__disableDefault())
  await addAnotherAccount()
  await page.getByLabel("DeepSeek API key", { exact: true }).fill("fixture-key")
  await page.getByRole("button", { name: "Connect", exact: true }).click()
  await page.getByRole("button", { name: "Save changes", exact: true }).waitFor()
  expect(await calls("creations")).toHaveLength(1)
  expect((await calls("writes"))[0].providerID).not.toBe("deepseek")
  expect(errors).toEqual([])
})

test("an in-flight account update stays locked across section remounts", async () => {
  await page.getByRole("button", { name: "Edit account", exact: true }).click()
  const remark = page.getByLabel("Account remark (optional)", { exact: true })
  await remark.fill("Submitted key")
  await flags({ __pauseUpdate: true })
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
  await page.waitForFunction(() => typeof (window as unknown as FixtureWindow).__releaseUpdate === "function")
  await page.getByRole("button", { name: "Models page", exact: true }).click()
  await page.getByRole("button", { name: "Providers page", exact: true }).click()
  expect(await remark.isDisabled()).toBe(true)
  await page.evaluate(() => (window as unknown as FixtureWindow).__releaseUpdate())
  await page.getByRole("button", { name: "Refresh connection", exact: true }).click()
  await page.getByRole("button", { name: "Save changes", exact: true }).waitFor()
  expect(await remark.inputValue()).toBe("Submitted key")
  await flags({ __pauseUpdate: false })
  await remark.fill("Next key")
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
  await page.waitForFunction(() => (window as unknown as FixtureWindow).__resourceCalls.updates.length === 2)
  expect(await remark.inputValue()).toBe("Next key")
  expect(errors).toEqual([])
})

test("first sign-in preserves a configured endpoint and enabled state while changing its remark", async () => {
  await page.evaluate(() => (window as unknown as FixtureWindow).__configureFirstAccount())
  await page.getByRole("button", { name: "Add third-party provider", exact: true }).click()
  await page.locator(".providers-row").filter({ hasText: "Test Service" }).click()
  expect(await page.getByLabel("Account remark (optional)", { exact: true }).inputValue()).toBe("Configured key")
  await page.locator(".providers-advanced > summary").click()
  expect(await page.getByLabel("API endpoint", { exact: true }).inputValue()).toBe("https://configured.example.com/v1")
  await page.getByRole("button", { name: "Back to services", exact: true }).click()
  await page.locator(".providers-row").filter({ hasText: "Test Service" }).waitFor()
  await page.locator(".providers-row").filter({ hasText: "Test Service" }).click()
  await page.getByLabel("Account remark (optional)", { exact: true }).fill("Personal key")
  await page.getByLabel("Configured key API key", { exact: true }).fill("fixture-key")
  await page.getByRole("button", { name: "Connect", exact: true }).click()
  await page.getByRole("button", { name: "Save changes", exact: true }).waitFor()
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).__resourceCalls.updates)).toEqual([
    { providerID: "test-service", providerConnectionUpdateInput: { name: "Personal key" } },
  ])
  expect(await page.getByRole("switch", { name: "Enabled", exact: true }).isChecked()).toBe(false)
  expect(await calls("creations")).toHaveLength(0)
  expect(errors).toEqual([])
})

test("provider discovery separates connected accounts and restores search and entry focus on return", async () => {
  expect(await page.locator(".providers-connected-account").count()).toBe(1)
  expect(await page.locator(".providers-directory").count()).toBe(0)
  await page.getByRole("button", { name: "Add third-party provider", exact: true }).click()
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
  await page.getByRole("button", { name: "Add third-party provider", exact: true }).click()
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
  await page.getByRole("button", { name: "Save changes", exact: true }).waitFor()
  expect(await page.evaluate(() => (window as any).__resourceCalls.writes.length)).toBe(1)
  expect(errors).toEqual([])
})
test("adding an account waits for Connect and resumes the saved connection after a failed read", async () => {
  await addAnotherAccount()
  await page.getByLabel("Account remark (optional)", { exact: true }).fill("Work account")
  expect(await calls("creations")).toHaveLength(0)
  await page.getByLabel("DeepSeek API key", { exact: true }).fill("fixture-key")
  await flags({ __failRead: true })
  await page.getByRole("button", { name: "Connect", exact: true }).click()
  await page.getByText("Refresh failed", { exact: true }).waitFor()
  expect(await calls("writes")).toHaveLength(0)
  await page.getByRole("button", { name: "Connect", exact: true }).click()
  await page.getByRole("button", { name: "Save changes", exact: true }).waitFor()
  expect(await calls("creations")).toHaveLength(1)
  const writes = await calls("writes")
  expect(writes).toHaveLength(1)
  expect(writes[0].providerID).not.toBe("deepseek")
  expect(errors).toEqual([])
})

test("an interrupted additional account remains available to continue or remove", async () => {
  await addAnotherAccount()
  await page.getByLabel("Account remark (optional)", { exact: true }).fill("Work account")
  await page.getByLabel("DeepSeek API key", { exact: true }).fill("fixture-key")
  await flags({ __failWrite: true })
  await page.getByRole("button", { name: "Connect", exact: true }).click()
  await page.getByText("Credential rejected", { exact: true }).waitFor()
  await page.getByRole("button", { name: "Back to accounts", exact: true }).click()
  expect(await page.getByRole("dialog", { name: "Discard unsaved changes?", exact: true }).count()).toBe(1)
  await page.getByRole("button", { name: "Keep Editing", exact: true }).click()
  expect(await page.getByLabel("DeepSeek API key", { exact: true }).inputValue()).toBe("fixture-key")
  await page.getByRole("button", { name: "Back to accounts", exact: true }).click()
  await page.getByRole("button", { name: "Discard", exact: true }).click()
  const account = page.locator(".providers-connected-account").filter({ hasText: "Work account" })
  await account.getByRole("button", { name: "Edit account", exact: true }).click()
  await page.getByLabel("Work account API key", { exact: true }).waitFor()
  await page.getByRole("button", { name: "Back to accounts", exact: true }).click()
  await account.getByRole("button", { name: "Account actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Remove account", exact: true }).click()
  await page.getByRole("button", { name: "Remove account", exact: true }).click()
  await account.waitFor({ state: "detached" })
  expect(errors).toEqual([])
})

test("model list status is neutral until an actual refresh failure and keeps usable models", async () => {
  await page.locator(".providers-connected-open").click()
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
  await addAnotherAccount()
  await page.getByLabel("Account remark (optional)", { exact: true }).fill("Work account")
  await page.getByLabel("DeepSeek API key", { exact: true }).fill("fixture-key")
  await page.getByRole("button", { name: "Models page", exact: true }).click()
  await page.getByRole("button", { name: "Providers page", exact: true }).click()
  expect(await page.getByLabel("Account remark (optional)", { exact: true }).inputValue()).toBe("Work account")
  expect(await page.getByLabel("DeepSeek API key", { exact: true }).inputValue()).toBe("fixture-key")
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await page.getByRole("button", { name: "Keep Editing", exact: true }).click()
  expect(await page.getByLabel("Account remark (optional)", { exact: true }).inputValue()).toBe("Work account")
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await page.getByRole("button", { name: "Discard", exact: true }).click()
  await addAnotherAccount()
  expect(await page.getByLabel("Account remark (optional)", { exact: true }).inputValue()).toBe("")
  expect(await page.getByLabel("DeepSeek API key", { exact: true }).inputValue()).toBe("")
  expect(await calls("creations")).toHaveLength(0)
  expect(errors).toEqual([])
})

test("a lost creation response is recovered using the same account identity", async () => {
  await addAnotherAccount()
  await page.getByLabel("DeepSeek API key", { exact: true }).fill("fixture-key")
  await flags({ __loseCreateResponse: true })
  await page.getByRole("button", { name: "Connect", exact: true }).evaluate((button) => {
    ;(button as HTMLButtonElement).click()
    ;(button as HTMLButtonElement).click()
  })
  await page.getByRole("button", { name: "Save changes", exact: true }).waitFor()
  expect(await calls("creations")).toHaveLength(1)
  expect(await calls("writes")).toHaveLength(1)
  expect((await calls("creations"))[0].id).toBe((await calls("writes"))[0].providerID)
  expect(errors).toEqual([])
})

test("first OAuth sign-in does not allocate a sibling and disposed callbacks cannot complete the view", async () => {
  await page.getByRole("button", { name: "Add third-party provider", exact: true }).click()
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
  await page.getByRole("button", { name: "Add third-party provider", exact: true }).click()
  await page.locator(".providers-row").filter({ hasText: "OpenAI Codex" }).click()
  await page.locator(".provider-method-row").first().click()
  await page.getByText("Waiting for authorization", { exact: false }).waitFor()
  await page.evaluate(() => (window as unknown as FixtureWindow).__finishOAuth())
  await page.getByRole("button", { name: "Save changes", exact: true }).waitFor()
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).__resourceCalls.toasts)).toHaveLength(1)
  await page.getByRole("button", { name: "Back to accounts", exact: true }).click()
  await addAnotherAccount("OpenAI Codex")
  await page.locator(".provider-method-row").first().click()
  await page.getByText("Waiting for authorization", { exact: false }).waitFor()
  const authorizations = await page.evaluate(() => (window as unknown as FixtureWindow).__resourceCalls.authorizations)
  expect(authorizations).toHaveLength(2)
  expect(authorizations[1].providerID).toBe((await calls("creations"))[0].id)
  expect(authorizations[1].providerID).not.toBe("openai-codex")
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await page.getByRole("button", { name: "Discard", exact: true }).click()
  await page.evaluate(() => (window as unknown as FixtureWindow).__finishOAuth())
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).__resourceCalls.toasts)).toHaveLength(1)
  expect(errors).toEqual([])
})

test("a late credential write does not complete a disposed connection view", async () => {
  await page.getByRole("button", { name: "Add third-party provider", exact: true }).click()
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

test("account editor, menus and setup cancellation work from the keyboard at narrow widths", async () => {
  await page.setViewportSize({ width: 375, height: 812 })
  for (const theme of ["light", "dark"]) {
    await page.goto(url + "?theme=" + theme)
    await page.getByRole("button", { name: "Edit account", exact: true }).press("Enter")
    const advanced = page.locator(".providers-advanced > summary")
    await advanced.press("Enter")
    expect(await page.getByLabel("API endpoint", { exact: true }).isVisible()).toBe(true)
    await advanced.press("Enter")
    expect(await page.getByLabel("API endpoint", { exact: true }).isVisible()).toBe(false)
    await page.getByRole("button", { name: "Cancel", exact: true }).press("Enter")
    await page.waitForFunction(() => document.activeElement?.hasAttribute("data-provider-id"))
    await addAnotherAccount()
    await page.getByRole("button", { name: "Cancel", exact: true }).press("Enter")
    await page.waitForFunction(() => document.activeElement?.hasAttribute("data-provider-id"))
    expect(await page.locator(".providers-auth-warning").count()).toBe(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
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
  await page.getByRole("button", { name: "Add third-party provider", exact: true }).click()
  await page.locator(".providers-row").filter({ hasText: "Test Service" }).click()
  await page.getByRole("button", { name: "Refresh connection", exact: true }).waitFor()
  await page.getByRole("button", { name: "Models page", exact: true }).click()
  await page.getByRole("button", { name: "Providers page", exact: true }).click()
  await page.getByRole("button", { name: "Refresh connection", exact: true }).waitFor()
  expect(await calls("writes")).toHaveLength(1)
  await page.getByRole("button", { name: "Refresh connection", exact: true }).click()
  await page.getByRole("button", { name: "Save changes", exact: true }).waitFor()
  expect(
    await page.evaluate(
      () => (window as unknown as { __resourceCalls: { writes: unknown[] } }).__resourceCalls.writes.length,
    ),
  ).toBe(1)
  expect(errors).toEqual([])
})
