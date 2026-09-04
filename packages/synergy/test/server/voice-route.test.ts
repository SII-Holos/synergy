import { afterEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import { Config } from "../../src/config/config"
import { Voice } from "../../src/voice"
import { VoiceRoute } from "../../src/server/voice-route"

const originalConfigCurrent = Config.current

function app() {
  return new Hono().route("/voice", VoiceRoute)
}

function audioFile(bytes: Uint8Array = new Uint8Array([1, 2, 3]), type = "audio/webm") {
  return new File([bytes as BlobPart], "dictation.webm", { type })
}

function stubConfig(voice: Record<string, unknown> | undefined) {
  ;(Config.current as typeof Config.current) = mock(async () => ({ voice }) as any)
}

afterEach(() => {
  ;(Config.current as typeof Config.current) = originalConfigCurrent
  Voice.resetClientFactoryForTest()
})

describe("voice transcribe route", () => {
  test("rejects non-audio and missing files", async () => {
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
  })

  test("rejects empty audio recordings", async () => {
    stubConfig({ stt: { model: "whisper-1" } })

    const form = new FormData()
    form.append("file", audioFile(new Uint8Array(0)))
    const response = await app().request("/voice/transcribe", { method: "POST", body: form })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { message: string }
    expect(body.message).toContain("Empty audio")
  })

  test("returns actionable error when stt is not configured", async () => {
    stubConfig(undefined)

    const form = new FormData()
    form.append("file", audioFile())
    const response = await app().request("/voice/transcribe", { method: "POST", body: form })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { message: string; reason: string }
    expect(body.reason).toBe("voice_stt_not_configured")
    expect(body.message).toContain("voice.stt.model")
  })

  test("transcribes audio and forwards context and language", async () => {
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
  })

  test("surfaces provider failures as 400 with message", async () => {
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
  })
})
