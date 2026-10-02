import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"
import { lingui } from "@lingui/vite-plugin"

let browser: Browser
let page: Page
let server: ViteDevServer
let fixture: string
let url: string
const errors: string[] = []

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
    const capabilities = { reasoning: true, input: { text: true, image: false, pdf: false, video: false, audio: false }, output: { text: true, audio: false } }
    const model = { id: "chat", name: "Test Chat", capabilities, cost: { input: 1, output: 1 }, variants: {} }
    const base = (id, connected) => ({ id, name: id === "deepseek" ? "DeepSeek" : "Test Service", profileID: id, catalogProviderID: id, configured: true, enabled: true, removable: false, canCreateSibling: true, connected, modelCount: 1, models: { chat: model }, catalog: { source: "bundled", refreshing: false }, health: { status: connected ? "healthy" : "unconfigured", source: "api" } })
    const [data, setData] = createStore({ provider: { all: [base("deepseek", true), base("test-service", false)], connected: ["deepseek"], profiles: {}, default: { deepseek: "chat" } }, provider_auth: { deepseek: [{ type: "api", label: "API key" }], "test-service": [{ type: "api", label: "API key" }] } })
    const writes = []; const creations = []; const authenticated = new Set(["deepseek"])
    window.__resourceCalls = { writes, creations }
    window.__useImport = () => setData("provider_auth", "test-service", [{ type: "import", label: "Import credentials" }])
    export const summaries = () => data.provider.all.map(provider => ({ ...provider, connected: data.provider.connected.includes(provider.id) }))
    export function useGlobalSync() { return { data, refreshProviders: async () => { if (window.__failRead) { window.__failRead = false; throw new Error("Refresh failed") } setData("provider", "connected", [...authenticated]) } } }
    export function useGlobalSDK() { return { client: {
      auth: { set: async input => { if (window.__failWrite) throw { data: { message: "Credential rejected" } }; writes.push(input); authenticated.add(input.providerID) } },
      provider: { credentials: { importCredentials: async input => { writes.push(input); authenticated.add(input.providerID) } }, models: { refresh: async () => ({ data: {} }) }, connection: {
        create: async ({ providerConnectionCreateInput: input }) => { creations.push(input); const account = { ...base(input.profileID, false), id: "account-work", name: input.name, removable: true }; setData("provider", "all", [...data.provider.all, account]); return { data: account } },
        update: async () => ({ data: data.provider.all[0] }), remove: async () => {} }, disconnect: async () => {} }
    } } }
    export function useProviders() { return { all: () => data.provider.all, connected: () => data.provider.all.filter(provider => data.provider.connected.includes(provider.id)), default: () => data.provider.default, ensureCatalog: async () => {} } }
    export function useLocal() { return { model: { current: () => undefined, set: () => { window.__sessionChanged = true } } } }
    export function usePlatform() { return { openLink: () => {} } }
  `,
  )
  await Bun.write(path.join(fixture, "toast.ts"), "export function showToast() {}")
  await Bun.write(
    path.join(fixture, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { createSignal, Show } from "solid-js"
    import { createStore } from "solid-js/store"
    import { setupI18n } from "@lingui/core"
    import { I18nProvider } from "@lingui/solid"
    import { DialogProvider } from "@ericsanchezok/synergy-ui/context/dialog"
    import { ProvidersPanel } from "/@fs/${app}/components/settings/panels/ProvidersPanel.tsx"
    import { ModelsPanel } from "/@fs/${app}/components/settings/panels/ModelsPanel.tsx"
    import { MODEL_ROLES, defaultSettingsState } from "/@fs/${app}/components/settings/types.ts"
    import { summaries, useGlobalSync } from "./api"
    import { providerFlow } from "/@fs/${app}/locales/messages.ts"
    const i18n = setupI18n({ locale: "en" })
    i18n.loadAndActivate({ locale: "en", messages: Object.fromEntries(Object.values(providerFlow).map(copy => [copy.id, copy.message])) })
    function Fixture() {
      const [view, setView] = createSignal("providers")
      const [models, setModels] = createStore({ ...defaultSettingsState().models, model: "deepseek/chat" })
      const [layer, setLayer] = createSignal()
      const [repair, setRepair] = createSignal("")
      const saved = { ...models }
      const roles = MODEL_ROLES.map(role => ({ id: role.key === "model" ? "primary" : role.key.replace("_model", ""), field: role.key, label: role.key, summary: "", fallbackChain: role.key === "model" ? ["model"] : [role.key, "model"], usedBy: [], resolvedModel: { providerID: "deepseek", modelID: "chat", via: "model" } }))
      return <div class="settings-panel-frame"><button onClick={() => setView("models")}>Models page</button><button onClick={() => setView("providers")}>Providers page</button><button onClick={() => setModels("model", "missing/chat")}>Unavailable model</button>
        <Show when={view() === "providers"} fallback={<ModelsPanel models={models} savedModels={saved} roleVariant={{}} modelRoleSummaries={() => roles} providerModels={() => [{ providerId: "deepseek", providerName: "DeepSeek", id: "chat", name: "Test Chat", variantKeys: [] }]} popoverLayer={layer()} onModelChange={(key, value) => setModels(key, value)} onVariantChange={() => {}} onQuickSwitcherChange={preferences => setModels("quick_switcher", preferences)} onConnectProvider={setRepair} />}>
          <ProvidersPanel summaries={summaries()} authMethods={useGlobalSync().data.provider_auth} />
        </Show><output data-testid="models">{JSON.stringify(models)}</output><output data-testid="repair">{repair()}</output><div ref={setLayer} />
      </div>
    }
    render(() => <I18nProvider i18n={i18n}><DialogProvider><Fixture /></DialogProvider></I18nProvider>, document.getElementById("root"))
  `,
  )
  server = await createServer({
    configFile: false,
    root: fixture,
    plugins: [solidPlugin(), ...lingui()],
    cacheDir: path.join(fixture, ".vite"),
    optimizeDeps: {
      noDiscovery: true,
      include: [
        "@lingui/core",
        "@lingui/solid",
        "@solid-primitives/resize-observer",
        "fuzzysort",
        "remeda",
        "solid-js",
        "solid-js/store",
        "solid-js/web",
        "solid-list",
      ],
    },
    resolve: {
      alias: [
        ...["global-sdk", "global-sync", "local", "platform"].map((name) => ({
          find: "@/context/" + name,
          replacement: path.join(fixture, "api.ts"),
        })),
        { find: "@/hooks/use-providers", replacement: path.join(fixture, "api.ts") },
        { find: "@ericsanchezok/synergy-ui/toast", replacement: path.join(fixture, "toast.ts") },
        { find: "@/", replacement: app + "/" },
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
  const warmup = await browser.newPage()
  await warmup.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 })
  await warmup.getByRole("heading", { name: "Providers", exact: true }).waitFor({ timeout: 30000 })
  await warmup.close()
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

test("provider discovery is a separate view from connected accounts", async () => {
  expect(await page.locator(".providers-connected-account").count()).toBe(1)
  expect(await page.locator(".providers-directory").count()).toBe(0)
  await page.getByRole("button", { name: "Add service", exact: true }).click()
  await page.getByRole("textbox", { name: "Search providers..." }).fill("Test Service")
  expect(await page.locator(".providers-row").count()).toBe(1)
  await page.locator(".providers-row").click()
  await page.getByLabel("Test Service API key", { exact: true }).waitFor()
  expect(await page.locator(".providers-directory").count()).toBe(0)
  expect(await page.getByRole("button", { name: "Connect", exact: true }).count()).toBe(1)
  expect(errors).toEqual([])
})
test("returning from a service preserves its directory search and restores the entry focus", async () => {
  await page.getByRole("button", { name: "Add service", exact: true }).click()
  await page.getByRole("textbox", { name: "Search providers..." }).fill("Test Service")
  await page.locator(".providers-row").click()
  await page.getByLabel("Test Service API key", { exact: true }).waitFor()
  await page.getByRole("button", { name: "Back to services", exact: true }).click()
  expect(await page.getByRole("textbox", { name: "Search providers..." }).inputValue()).toBe("Test Service")
  await page.waitForFunction(() => document.activeElement?.classList.contains("providers-row"))
  expect(errors).toEqual([])
})
test("credential failure remains in the flow and a failed refresh retries only the read", async () => {
  await page.getByRole("button", { name: "Add service", exact: true }).click()
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
  await page.getByText("Refresh failed", { exact: true }).waitFor()
  await page.getByRole("button", { name: "Refresh connection", exact: true }).click()
  await page.getByRole("button", { name: "Update credentials", exact: true }).waitFor()
  expect(await page.evaluate(() => (window as any).__resourceCalls.writes.length)).toBe(1)
  expect(errors).toEqual([])
})
test("account creation stays in one flow and an unfinished connection can be resumed", async () => {
  await page.locator(".providers-connected-account").click()
  await page.getByRole("button", { name: "Add account", exact: true }).click()
  await page.getByLabel("Account name", { exact: true }).fill("Work account")
  await page.evaluate(() => {
    ;(window as any).__failRead = true
  })
  await page.getByRole("button", { name: "Create account", exact: true }).click()
  await page.getByRole("button", { name: "Refresh connection", exact: true }).click()
  await page.getByLabel("Work account API key", { exact: true }).waitFor()
  expect(await page.evaluate(() => (window as any).__resourceCalls.creations.length)).toBe(1)
  await page.getByRole("button", { name: "Back to accounts", exact: true }).click()
  await page.locator(".providers-connected-account").filter({ hasText: "Work account" }).click()
  await page.getByLabel("Work account API key", { exact: true }).waitFor()
  await page.getByRole("button", { name: "Remove account", exact: true }).waitFor()
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
test("unavailable selections are preserved with a service repair entry", async () => {
  await page.getByRole("button", { name: "Models page", exact: true }).click()
  await page.getByRole("button", { name: "Unavailable model", exact: true }).click()
  await page.getByText("This model is unavailable.", { exact: false }).waitFor()
  await page.getByRole("button", { name: "Check service", exact: true }).click()
  expect(await page.getByTestId("repair").textContent()).toBe("missing")
  expect(JSON.parse((await page.getByTestId("models").textContent())!).model).toBe("missing/chat")
})

test("a completed credential import retries only account refresh", async () => {
  await page.evaluate(() => {
    ;(window as unknown as { __useImport(): void; __failRead: boolean }).__useImport()
    ;(window as unknown as { __failRead: boolean }).__failRead = true
  })
  await page.getByRole("button", { name: "Add service", exact: true }).click()
  await page.locator(".providers-row").filter({ hasText: "Test Service" }).click()
  await page.getByRole("button", { name: "Refresh connection", exact: true }).click()
  await page.getByRole("button", { name: "Update credentials", exact: true }).waitFor()
  expect(
    await page.evaluate(
      () => (window as unknown as { __resourceCalls: { writes: unknown[] } }).__resourceCalls.writes.length,
    ),
  ).toBe(1)
  expect(errors).toEqual([])
})
