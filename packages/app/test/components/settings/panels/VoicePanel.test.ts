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
let fixtureUrl: string

const DEFAULT_VOICE_CONFIG = {
  voice: {
    stt: {
      baseURL: "https://stt.example/v1",
      apiKey: "sk-stt-stored",
      model: "qwen3-asr-flash",
      language: "zh",
    },
    tts: { baseURL: "", model: "", voice: "", instructions: "" },
  },
}

const stubModules: Record<string, string> = {
  "stub-global-sdk.ts": `
    import { createSignal } from "solid-js"

    const initial = (globalThis as any).__voiceInitial ?? ${JSON.stringify(DEFAULT_VOICE_CONFIG)}
    const stored = createSignal<Record<string, unknown>>(initial)
    const updates: Array<{ domain: string; input: unknown }> = []
    if (typeof window !== "undefined") {
      ;(window as any).__voiceUpdates = () => updates
      ;(window as any).__voiceStored = () => stored[0]()
    }

    function deepMerge(base: any, patch: any): any {
      if (
        patch === undefined ||
        Array.isArray(base) ||
        Array.isArray(patch) ||
        typeof patch !== "object" ||
        patch === null ||
        typeof base !== "object" ||
        base === null
      ) {
        return patch
      }
      const out: Record<string, unknown> = { ...base }
      for (const [key, value] of Object.entries(patch)) out[key] = deepMerge(base[key], value)
      return out
    }

    export function useGlobalSDK() {
      const [value, setValue] = stored
      return {
        url: "http://localhost",
        client: {
          config: {
            domain: {
              get: async ({ domain }: { domain: string }) => {
                if (domain !== "voice") throw new Error("unexpected domain: " + domain)
                return { data: value() }
              },
              update: async ({
                domain,
                configDomainUpdateInput,
              }: {
                domain: string
                configDomainUpdateInput: { config: Record<string, unknown> }
              }) => {
                if (domain !== "voice") throw new Error("unexpected domain: " + domain)
                updates.push({ domain, input: JSON.parse(JSON.stringify(configDomainUpdateInput)) })
                setValue(deepMerge(value(), configDomainUpdateInput.config))
                return { data: { config: value(), changedFields: ["voice"] } }
              },
            },
          },
        },
      }
    }
  `,
  "stub-toast.ts": `
    export function showToast() {}
  `,
}

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".voice-panel-fixture-"))
  const panelPath = path.resolve(import.meta.dir, "../../../../src/components/settings/panels/VoicePanel.tsx")

  await Promise.all([
    Bun.write(
      path.join(fixtureDirectory, "index.html"),
      '<div id="root"></div><script type="module" src="/main.tsx"></script>',
    ),
    ...Object.entries(stubModules).map(([name, source]) => Bun.write(path.join(fixtureDirectory, name), source)),
    Bun.write(
      path.join(fixtureDirectory, "main.tsx"),
      `
        import { render } from "solid-js/web"
        import { setupI18n } from "@lingui/core"
        import { I18nProvider } from "@lingui/solid"
        import { VoicePanel } from ${JSON.stringify(`/@fs/${panelPath}`)}

        const i18n = setupI18n({ locale: "en" })

        render(
          () => (
            <I18nProvider i18n={i18n}>
              <VoicePanel />
            </I18nProvider>
          ),
          document.querySelector("#root")!,
        )
      `,
    ),
  ])

  const appSrc = path.resolve(import.meta.dir, "../../../../src")

  server = await createServer({
    configFile: false,
    root: fixtureDirectory,
    plugins: [solidPlugin()],
    resolve: {
      alias: [
        { find: "@/context/global-sdk", replacement: path.join(fixtureDirectory, "stub-global-sdk.ts") },
        { find: "@ericsanchezok/synergy-ui/toast", replacement: path.join(fixtureDirectory, "stub-toast.ts") },
        { find: "@/", replacement: `${appSrc}/` },
      ],
    },
    server: {
      host: "127.0.0.1",
      port: 5231,
      strictPort: true,
      fs: { allow: [path.resolve(import.meta.dir, "../../../..")] },
    },
  })
  await server.listen()

  const url = server.resolvedUrls?.local[0]
  if (!url) throw new Error("Expected Vite test server URL")
  fixtureUrl = url

  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 900, height: 700 } })
  await page.goto(fixtureUrl)
})

afterAll(async () => {
  await page?.close()
  await browser?.close()
  await server?.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

describe("VoicePanel", () => {
  test("renders both sections, populates from the voice config, and saves a domain update", async () => {
    // The whole contract runs as one browser session: bun test reaps the
    // Playwright browser between tests, so a single sequential test keeps
    // the page alive (same pattern as BossModePanel.test.ts).

    // 1. Renders the page and both sections.
    await expect(page.locator(".ds-content-title").first().textContent()).resolves.toBe("Voice")
    const sections = page.locator(".ds-section-label")
    expect(await sections.count()).toBe(2)
    expect(await sections.nth(0).textContent()).toBe("Speech recognition (STT)")
    expect(await sections.nth(1).textContent()).toBe("Speech synthesis (TTS)")

    // 2. Non-secret fields populate from the loaded config; the stored key is
    //    never echoed into the field and shows a "Saved" placeholder instead.
    const inputs = page.locator('input[data-slot="input-input"]')
    const values = await inputs.evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).value))
    const placeholders = await inputs.evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLInputElement).placeholder),
    )
    const types = await inputs.evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).type))
    expect(values).toContain("https://stt.example/v1")
    expect(values).toContain("qwen3-asr-flash")
    expect(values).toContain("zh")
    expect(types.filter((type) => type === "password").length).toBe(2)
    expect(values.filter((value) => value.startsWith("sk-")).length).toBe(0)
    expect(placeholders.filter((placeholder) => placeholder === "Saved").length).toBe(1)

    // Field order inside each section: baseURL, apiKey, model, language for
    // STT and baseURL, apiKey, model, voice for TTS (instructions is a
    // textarea). Solid binds values as properties, so selectors address the
    // inputs positionally rather than by attribute.
    const sttModel = inputs.nth(2)
    expect(await sttModel.inputValue()).toBe("qwen3-asr-flash")

    // 3. Save dispatches the domain update with the expected payload.
    await sttModel.fill("whisper-1")
    const saveButton = page.locator('button[data-component="button"]', { hasText: "Save" })
    await saveButton.click()
    await page.waitForFunction(() => (window as any).__voiceUpdates().length === 1)
    const update = await page.evaluate(() => (window as any).__voiceUpdates()[0])
    expect(update).toEqual({
      domain: "voice",
      input: { config: { voice: { stt: { model: "whisper-1" } } } },
    })

    // 4. After save the panel re-reads the server value: the new model shows
    //    and the still-stored key remains masked (empty value, "Saved" hint).
    await expect(page.locator('input[data-slot="input-input"]').nth(2).inputValue()).resolves.toBe("whisper-1")
    const afterSave = await page
      .locator('input[data-slot="input-input"]')
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).value))
    expect(afterSave.filter((value) => value.startsWith("sk-")).length).toBe(0)
    const afterSavePlaceholders = await page
      .locator('input[data-slot="input-input"]')
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).placeholder))
    expect(afterSavePlaceholders.filter((placeholder) => placeholder === "Saved").length).toBe(1)
    // 5. Unconfigured render: an empty voice config leaves the panel clean
    //    and the Save action disabled (no changes to persist).
    await page.addInitScript(() => {
      ;(window as any).__voiceInitial = {}
    })
    await page.reload()
    await expect(page.locator(".ds-content-title").first().textContent()).resolves.toBe("Voice")
    expect(await page.locator(".ds-section-label").count()).toBe(2)
    const emptyValues = await page
      .locator('input[data-slot="input-input"]')
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).value))
    expect(emptyValues.filter((value) => value !== "").length).toBe(0)
    const unconfiguredSave = page.locator('button[data-component="button"]', { hasText: "Save" })
    expect(await unconfiguredSave.isDisabled()).toBe(true)
  })
})
