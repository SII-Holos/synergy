import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
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

    const initial = ${JSON.stringify(DEFAULT_VOICE_CONFIG)}
    if (location.search.includes("disabled")) initial.voice.stt.enabled = false
    if (location.search.includes("preview")) initial.voice.tts = { model: "gpt-4o-mini-tts", baseURL: "", voice: "", instructions: "" }
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
          voice: { preview: async (_input, options) => {
            if (location.search.includes("failure")) throw { data: { message: "Speech service unavailable", reason: "voice_preview_failed" } }
            if (location.search.includes("pending")) return new Promise((resolve, reject) => { options.signal.addEventListener("abort", () => { window.__voiceAborted = true; reject(new DOMException("Stopped", "AbortError")) }) })
            return { data: new Blob([new Uint8Array(44)], { type: "audio/wav" }) }
          }, transcribe: async ({ file }, options) => {
            window.__voiceTranscriptions = (window.__voiceTranscriptions ?? 0) + 1
            window.__voiceRecorded = { size: file.size, type: file.type }
            if (location.search.includes("transcribe-no-speech")) throw { data: { reason: "voice_no_speech", message: "Empty transcript" } }
            if (location.search.includes("transcribe-failure")) throw { data: { reason: "voice_transcription_failed", message: "Transcription service unavailable" } }
            if (location.search.includes("transcribe-pending")) return new Promise((resolve, reject) => { options.signal.addEventListener("abort", () => { window.__voiceAborted = true; reject(new DOMException("Stopped", "AbortError")) }) })
            return { data: { text: "Synthetic microphone transcript" } }
          } },
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
        import { createSignal, Show } from "solid-js"
        import { createVoiceController } from ${JSON.stringify(`/@fs/${path.resolve(import.meta.dir, "../../../../src/components/settings/panels/voice-controller.ts")}`)}
        import { useGlobalSDK } from "./stub-global-sdk"
        import { VoicePanel } from ${JSON.stringify(`/@fs/${panelPath}`)}

        const i18n = setupI18n({ locale: "en" })

        const api = useGlobalSDK().client.config.domain
        const controller = createVoiceController({ get: async () => (await api.get({ domain: "voice" })).data.voice, update: async (voice) => (await api.update({ domain: "voice", configDomainUpdateInput: { config: { voice } } })).data.config.voice })
        const [visible, setVisible] = createSignal(true)
        void controller.load()
        render(
          () => (
            <I18nProvider i18n={i18n}>
              <button onClick={() => setVisible(!visible())}>Switch page</button>
              <Show when={visible()}><VoicePanel controller={controller} /></Show>
              <button disabled={!controller.dirty()} onClick={() => void controller.save()}>Save changes</button>
            </I18nProvider>
          ),
          document.querySelector("#root")!,
        )
      `,
    ),
  ])

  const appSrc = path.resolve(import.meta.dir, "../../../../src")
  const uiRequire = createRequire(path.resolve(import.meta.dir, "../../../../../../packages/ui/package.json"))

  server = await createServer({
    configFile: false,
    root: fixtureDirectory,
    cacheDir: path.join(fixtureDirectory, ".vite"),
    plugins: [solidPlugin()],
    optimizeDeps: {
      noDiscovery: true,
      include: ["solid-js", "solid-js/web", "solid-js/store", "@lingui/core", "@lingui/solid", "lucide-solid"],
    },
    resolve: {
      alias: [
        { find: "lucide-solid", replacement: uiRequire.resolve("lucide-solid") },
        { find: "@/context/global-sdk", replacement: path.join(fixtureDirectory, "stub-global-sdk.ts") },
        { find: "@ericsanchezok/synergy-ui/toast", replacement: path.join(fixtureDirectory, "stub-toast.ts") },
        { find: "@/", replacement: `${appSrc}/` },
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
  fixtureUrl = url

  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 900, height: 700 } })
  await page.goto(fixtureUrl)
  page.setDefaultTimeout(5000)
})

afterAll(async () => {
  await page?.close()
  await browser?.close()
  await server?.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

describe("VoicePanel", () => {
  test("opening speech configuration does not enable a disabled capability or write preferences", async () => {
    await page.goto(fixtureUrl + "?disabled")
    expect(await page.getByLabel("Voice input: Model", { exact: true }).count()).toBe(0)
    await page.getByRole("button", { name: "Configure Voice input", exact: true }).click()
    expect(await page.getByLabel("Voice input: Model", { exact: true }).inputValue()).toBe("qwen3-asr-flash")
    expect(await page.getByRole("switch", { name: "Voice input", exact: true }).isChecked()).toBe(false)
    expect(await page.getByRole("button", { name: "Save changes", exact: true }).isEnabled()).toBe(false)
    expect(await page.evaluate(() => (window as unknown as { __voiceUpdates(): unknown[] }).__voiceUpdates())).toEqual(
      [],
    )
  })
  test("microphone recording shows transcripts, handles failures and cancels without saving preferences", async () => {
    for (const outcome of ["success", "no-speech", "failure", "pending", "cancel"] as const) {
      await page.goto(fixtureUrl + "?transcribe-" + outcome)
      await page.evaluate(() => {
        Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
          configurable: true,
          value: async () => {
            const context = new AudioContext()
            const tone = context.createOscillator()
            const destination = context.createMediaStreamDestination()
            tone.connect(destination)
            tone.start()
            await context.resume()
            ;(window as unknown as { __microphoneContext: AudioContext }).__microphoneContext = context
            ;(window as unknown as { __microphoneStream: MediaStream }).__microphoneStream = destination.stream
            return destination.stream
          },
        })
      })
      await page.getByRole("button", { name: "Test microphone", exact: true }).click()
      await page.getByRole("button", { name: "Stop", exact: true }).waitFor()
      if (outcome === "cancel") {
        await page.keyboard.press("Escape")
        await page.getByRole("alert").filter({ hasText: "Test stopped." }).waitFor()
        expect(
          await page.evaluate(
            () => (window as unknown as { __voiceTranscriptions?: number }).__voiceTranscriptions ?? 0,
          ),
        ).toBe(0)
      } else {
        await page.waitForTimeout(600)
        await page.getByRole("button", { name: "Stop", exact: true }).click()
        if (outcome === "pending") {
          await page.waitForFunction(
            () => (window as unknown as { __voiceTranscriptions: number }).__voiceTranscriptions === 1,
          )
          await page.getByRole("button", { name: "Switch page", exact: true }).click()
          await page.waitForFunction(() => (window as unknown as { __voiceAborted: boolean }).__voiceAborted === true)
        } else if (outcome === "success") {
          await page.getByRole("status").filter({ hasText: "Synthetic microphone transcript" }).waitFor()
          const recorded = await page.evaluate(
            () => (window as unknown as { __voiceRecorded: { size: number; type: string } }).__voiceRecorded,
          )
          expect(recorded.size).toBeGreaterThan(0)
          expect(recorded.type.startsWith("audio/")).toBe(true)
        } else {
          await page
            .getByRole("alert")
            .filter({
              hasText: outcome === "no-speech" ? "No speech was detected." : "Transcription service unavailable",
            })
            .waitFor()
        }
      }
      expect(
        await page.evaluate(() =>
          (window as unknown as { __microphoneStream: MediaStream }).__microphoneStream
            .getTracks()
            .every((track) => track.readyState === "ended"),
        ),
      ).toBe(true)
      expect(
        await page.evaluate(() => (window as unknown as { __voiceUpdates(): unknown[] }).__voiceUpdates().length),
      ).toBe(0)
      await page.evaluate(() =>
        (window as unknown as { __microphoneContext: AudioContext }).__microphoneContext.close(),
      )
    }
    await page.goto(fixtureUrl)
  })
  test("a custom speech endpoint stays visible while its required model is empty", async () => {
    await page.goto(fixtureUrl)
    await page.getByRole("heading", { name: "Voice", exact: true }).waitFor()
    const readAloud = page.getByRole("switch", { name: "Read answers aloud", exact: true })
    await readAloud.focus()
    await readAloud.press("Space")
    await page.getByRole("button", { name: "Read answers aloud: Service: OpenAI", exact: true }).click()
    await page.getByRole("option", { name: "Custom compatible service", exact: true }).click()
    await page
      .getByRole("textbox", { name: "Read answers aloud: API endpoint", exact: true })
      .last()
      .waitFor({ state: "visible", timeout: 3000 })
    expect(
      await page.getByRole("textbox", { name: "Read answers aloud: Model", exact: true }).getAttribute("aria-required"),
    ).toBe("true")
    expect(await page.getByRole("button", { name: "Preview voice", exact: true }).isDisabled()).toBe(true)
    await page.goto(fixtureUrl)
  })
  test("keeps cross-page voice drafts and saves through the shared source", async () => {
    await page.getByRole("heading", { name: "Voice", exact: true }).waitFor()
    const model = page.getByLabel("Voice input: Model", { exact: true })
    expect(await model.inputValue()).toBe("qwen3-asr-flash")
    await model.fill("whisper-1")
    await page.getByRole("button", { name: "Switch page" }).click()
    await page.getByRole("button", { name: "Switch page" }).click()
    expect(await model.inputValue()).toBe("whisper-1")
    expect(await page.getByRole("button", { name: "Test microphone" }).isDisabled()).toBe(true)
    await page.getByRole("button", { name: "Save changes" }).click()
    await page.waitForFunction(() => (window as any).__voiceUpdates().length === 1)
    expect(await page.evaluate(() => (window as any).__voiceUpdates()[0].input)).toEqual({
      config: { voice: { stt: { model: "whisper-1", enabled: true } } },
    })
    expect(await page.getByRole("button", { name: "Save changes" }).isDisabled()).toBe(true)
    expect(
      await page
        .locator("input")
        .evaluateAll((nodes) => nodes.some((node) => node instanceof HTMLInputElement && node.value.startsWith("sk-"))),
    ).toBe(false)
  })
  test("disables voice independently and clears optional fields instead of losing them", async () => {
    await page.reload()
    await page.getByRole("heading", { name: "Voice", exact: true }).waitFor()
    const enable = page.getByRole("switch", { name: "Voice input", exact: true })
    await enable.press("Space")
    await page.getByRole("button", { name: "Save changes" }).click()
    await page.waitForFunction(() => (window as any).__voiceUpdates().length === 1)
    expect(await page.evaluate(() => (window as any).__voiceStored().voice.stt)).toMatchObject({
      enabled: false,
      model: "qwen3-asr-flash",
    })
    await page.getByRole("button", { name: "Configure Voice input", exact: true }).click()
    await page.locator("summary").first().click()
    await page.getByLabel("Voice input: API endpoint", { exact: true }).fill("")
    await page.getByRole("button", { name: "Save changes" }).click()
    await page.waitForFunction(() => (window as any).__voiceUpdates().length === 2)
    expect(await page.evaluate(() => (window as any).__voiceStored().voice.stt.baseURL)).toBeNull()
  })
  test("preview uses saved configuration and stop releases the audio URL", async () => {
    await page.goto(fixtureUrl + "?preview")
    await page.getByRole("button", { name: "Preview voice" }).click()
    await page.locator("audio").waitFor()
    expect(await page.locator("audio").getAttribute("src")).toStartWith("blob:")
    expect(await page.evaluate(() => (window as any).__voiceUpdates().length)).toBe(0)
    await page.getByRole("button", { name: "Stop", exact: true }).click()
    expect(await page.locator("audio").count()).toBe(0)
  })
  test("preview failure is actionable and leaving the page cancels pending requests", async () => {
    await page.goto(fixtureUrl + "?preview-failure")
    await page.getByRole("button", { name: "Preview voice" }).click()
    await page.getByRole("alert").filter({ hasText: "Speech service unavailable" }).waitFor()
    await page.goto(fixtureUrl + "?preview-pending")
    await page.getByRole("button", { name: "Preview voice" }).click()
    await page.getByRole("button", { name: "Switch page" }).click()
    await page.waitForFunction(() => (window as any).__voiceAborted === true)
    expect(await page.locator("audio").count()).toBe(0)
  })
  test("microphone permission denial reports an actionable error", async () => {
    await page.goto(fixtureUrl)
    await page.evaluate(() => {
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: async () => {
          throw new DOMException("denied", "NotAllowedError")
        },
      })
    })
    await page.getByRole("button", { name: "Test microphone" }).click()
    await page.getByRole("alert").filter({ hasText: "permission was denied" }).waitFor()
  })
})
