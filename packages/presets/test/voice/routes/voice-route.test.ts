import { afterEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { Voice } from "@ericsanchezok/synergy-media/voice"
import { VoiceRoute } from "@ericsanchezok/synergy-media/voice/routes/voice-route"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../../support/runtime"
const runtime = await testRuntime()

runtime.run(() => Log.init({ print: false }))

const originalConfigCurrent = Config.current
const originalSpeak = Voice.speak

function app() {
  return new Hono().route("/voice", VoiceRoute())
}

function audioFile(bytes: Uint8Array = new Uint8Array([1, 2, 3]), type = "audio/webm") {
  return new File([bytes as BlobPart], "dictation.webm", { type })
}

function stubConfig(voice: Record<string, unknown> | undefined) {
  ;(Config.current as typeof Config.current) = mock(async () => ({ voice }) as any)
}

afterEach(() =>
  runtime.run(() => {
    ;(Config.current as typeof Config.current) = originalConfigCurrent
    Voice.resetClientFactoryForTest()
    Voice.speak = originalSpeak
  }),
)

describe("voice transcribe route", () => {
  test("rejects non-audio and missing files", () =>
    runtime.run(async () => {
      stubConfig({ stt: { model: "whisper-1" } })

      const missing = await app().request("/voice/transcribe", {
        method: "POST",
        body: new FormData(),
      })
      expect(missing.status).toBe(400)

      const form = new FormData()
      form.append("file", new File(["x"], "note.txt", { type: "text/plain" }))
      const notAudio = await app().request("/voice/transcribe", { method: "POST", body: form })
      expect(notAudio.status).toBe(400)
      const body = (await notAudio.json()) as { message: string }
      expect(body.message).toContain("Not an audio file")
    }))

  test("rejects empty audio recordings", () =>
    runtime.run(async () => {
      stubConfig({ stt: { model: "whisper-1" } })

      const form = new FormData()
      form.append("file", audioFile(new Uint8Array(0)))
      const response = await app().request("/voice/transcribe", { method: "POST", body: form })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { message: string }
      expect(body.message).toContain("Empty audio")
    }))

  test("returns actionable error when stt is not configured", () =>
    runtime.run(async () => {
      stubConfig(undefined)

      const form = new FormData()
      form.append("file", audioFile())
      const response = await app().request("/voice/transcribe", { method: "POST", body: form })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { message: string; reason: string }
      expect(body.reason).toBe("voice_stt_not_configured")
      expect(body.message).toContain("Settings → Voice")
    }))

  test("transcribes audio and forwards context and language", () =>
    runtime.run(async () => {
      stubConfig({ stt: { model: "gpt-4o-transcribe", apiKey: "sk-test" } })

      const calls: Array<{ data: Uint8Array; context?: string; language?: string }> = []
      const originalTranscribe = Voice.transcribe
      ;(Voice.transcribe as typeof Voice.transcribe) = mock(async (input) => {
        calls.push(input)
        return { text: "transcribed words" }
      })

      const form = new FormData()
      form.append("file", audioFile())
      form.append("context", "recent conversation context")
      form.append("language", "zh")
      const response = await app().request("/voice/transcribe", { method: "POST", body: form })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ text: "transcribed words" })
      expect(calls).toHaveLength(1)
      expect(calls[0]!.context).toBe("recent conversation context")
      expect(calls[0]!.language).toBe("zh")
      expect(Array.from(calls[0]!.data)).toEqual([1, 2, 3])
      ;(Voice.transcribe as typeof Voice.transcribe) = originalTranscribe
    }))

  test("surfaces provider failures as 400 with message", () =>
    runtime.run(async () => {
      stubConfig({ stt: { model: "whisper-1", apiKey: "bad" } })

      const originalTranscribe = Voice.transcribe
      ;(Voice.transcribe as typeof Voice.transcribe) = mock(async () => {
        throw new Error("provider 401: invalid api key")
      })

      const form = new FormData()
      form.append("file", audioFile())
      const response = await app().request("/voice/transcribe", { method: "POST", body: form })

      expect(response.status).toBe(400)
      const body = (await response.json()) as { message: string }
      expect(body.message).toContain("invalid api key")
      ;(Voice.transcribe as typeof Voice.transcribe) = originalTranscribe
    }))

  test("translates an empty-transcript provider result into a voice_no_speech reason", () =>
    runtime.run(async () => {
      stubConfig({ stt: { model: "whisper-1", apiKey: "test" } })

      const originalTranscribe = Voice.transcribe
      ;(Voice.transcribe as typeof Voice.transcribe) = mock(async () => {
        throw Object.assign(new Error("No transcript generated."), { name: "AI_NoTranscriptGeneratedError" })
      })

      const form = new FormData()
      form.append("file", audioFile())
      const response = await app().request("/voice/transcribe", { method: "POST", body: form })

      expect(response.status).toBe(400)
      const body = (await response.json()) as { message: string; reason: string }
      expect(body.reason).toBe("voice_no_speech")
      expect(body.message).toContain("No speech was detected")
      ;(Voice.transcribe as typeof Voice.transcribe) = originalTranscribe
    }))
})

describe("voice preview route", () => {
  const preview = (text: string, signal?: AbortSignal) =>
    app().request("/voice/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal,
    })

  test("publishes a binary contract and forwards the request cancellation signal", () =>
    runtime.run(async () => {
      const specs = await Server.openapi()
      const operation = specs.paths?.["/voice/preview"]?.post
      expect(operation?.operationId).toBe("voice.preview")
      expect(operation?.responses?.["200"]).toMatchObject({
        content: { "audio/wav": { schema: { type: "string", format: "binary" } } },
      })
      let signal: AbortSignal | undefined
      Voice.speak = mock(async (input) => {
        signal = input.abortSignal
        return { data: new Uint8Array([3, 2, 1]), mimeType: "audio/mpeg" }
      })
      const controller = new AbortController()
      const response = await preview("Hello", controller.signal)
      expect(response.headers.get("content-type")).toBe("audio/mpeg")
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([3, 2, 1])
      controller.abort()
      expect(signal?.aborted).toBe(true)
    }))

  test("keeps disabled and provider failure reasons distinct", () =>
    runtime.run(async () => {
      stubConfig({ tts: { model: "tts-1", enabled: false } })
      const disabled = await preview("Hello")
      expect(disabled.status).toBe(400)
      expect(await disabled.json()).toMatchObject({ reason: "voice_tts_not_configured" })
      Voice.speak = mock(async () => {
        throw new Error("Speech service unavailable")
      })
      const failed = await preview("Hello")
      expect(failed.status).toBe(400)
      expect(await failed.json()).toEqual({ reason: "voice_preview_failed", message: "Speech service unavailable" })
    }))

  test("requires Scope through the product server before calling the speech service", () =>
    runtime.run(async () => {
      let calls = 0
      Voice.speak = mock(async () => {
        calls++
        return { data: new Uint8Array([1]), mimeType: "audio/wav" }
      })
      const response = await Server.App().request("/voice/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Hello" }),
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ name: "ScopeRequired" })
      expect(calls).toBe(0)
    }))
})

describe("voice transcribe route scope enforcement", () => {
  test("returns ScopeRequired through the real server when no scope is supplied", () =>
    runtime.run(async () => {
      // The route must never fall through to the home scope and pay for an
      // external STT call from an unscoped request: exercise the real
      // Server.App() middleware, not the bare Hono mount above.
      const originalTranscribe = Voice.transcribe
      ;(Voice.transcribe as typeof Voice.transcribe) = mock(async () => {
        throw new Error("transcribe must not be reached without a scope")
      })

      const app = Server.App()
      const form = new FormData()
      form.append("file", audioFile())
      const response = await app.request("/voice/transcribe", { method: "POST", body: form })

      expect(response.status).toBe(400)
      const body = (await response.json()) as { name: string }
      expect(body.name).toBe("ScopeRequired")
      ;(Voice.transcribe as typeof Voice.transcribe) = originalTranscribe
    }))

  test("reaches the transcribe handler when a valid scope directory is supplied", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      const scope = (await Scope.fromDirectory(tmp.path)).scope
      stubConfig({ stt: { model: "gpt-4o-transcribe", apiKey: "sk-test" } })

      const originalTranscribe = Voice.transcribe
      ;(Voice.transcribe as typeof Voice.transcribe) = mock(async () => ({ text: "scoped transcription" }))

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const app = Server.App()
          const form = new FormData()
          form.append("file", audioFile())
          const response = await app.request(`/voice/transcribe?directory=${encodeURIComponent(tmp.path)}`, {
            method: "POST",
            body: form,
          })

          expect(response.status).toBe(200)
          expect(await response.json()).toEqual({ text: "scoped transcription" })
        },
      })
      ;(Voice.transcribe as typeof Voice.transcribe) = originalTranscribe
    }))
})

afterRuntimeTests(() => runtime.close())
