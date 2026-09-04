import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Config } from "../../src/config/config"
import { ConfigDomain } from "../../src/config/domain"
import { Global } from "../../src/global"
import { Voice, VoiceNotConfiguredError } from "../../src/voice"
import { createOpenAI } from "@ai-sdk/openai"

async function writeVoiceFragment(content: Record<string, unknown>) {
  const dir = ConfigDomain.directory(Global.Path.config)
  await fs.mkdir(dir, { recursive: true })
  await Bun.write(path.join(dir, "125-voice.jsonc"), JSON.stringify({ voice: content }))
}

type CallLog = Array<{ baseURL?: string; model: string; args: Record<string, unknown> }>

function fakeClientFactory(log: CallLog, result: { text?: string; audio?: Uint8Array }) {
  return ((options?: { baseURL?: string; apiKey?: string }) => {
    return {
      transcription(modelId: string) {
        return {
          specificationVersion: "v2" as const,
          provider: "openai",
          modelId,
          doGenerate: async (args: Record<string, unknown>) => {
            log.push({ baseURL: options?.baseURL, model: modelId, args })
            return {
              text: result.text ?? "hello",
              segments: [],
              language: "en",
              durationInSeconds: 1,
              warnings: [],
              response: { id: "fake", timestamp: new Date() },
            }
          },
        }
      },
      speech(modelId: string) {
        return {
          specificationVersion: "v2" as const,
          provider: "openai",
          modelId,
          doGenerate: async (args: Record<string, unknown>) => {
            log.push({ baseURL: options?.baseURL, model: modelId, args })
            return {
              audio: result.audio ?? new Uint8Array([1, 2, 3]),
              warnings: [],
              response: { id: "fake", timestamp: new Date() },
            }
          },
        }
      },
    }
  }) as unknown as typeof createOpenAI
}

describe("voice runtime", () => {
  afterEach(() => {
    Voice.resetClientFactoryForTest()
  })

  test("stt and tts report disabled when voice config is absent", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await Config.reload("global")
        expect(await Voice.sttEnabled()).toBe(false)
        expect(await Voice.ttsEnabled()).toBe(false)

        await expect(Voice.transcribe({ data: new Uint8Array([1]) })).rejects.toBeInstanceOf(VoiceNotConfiguredError)
        await expect(Voice.speak({ text: "hi" })).rejects.toBeInstanceOf(VoiceNotConfiguredError)

        const sttError = await Voice.transcribe({ data: new Uint8Array([1]) }).catch((error) => error)
        expect(sttError.message).toContain("voice.stt.model")
        const ttsError = await Voice.speak({ text: "hi" }).catch((error) => error)
        expect(ttsError.message).toContain("voice.tts.model")
      },
    })
  })

  test("transcribe passes configured model, endpoint, context, and language to the provider", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await writeVoiceFragment({
          stt: {
            baseURL: "https://dashscope.example.com/compatible-mode/v1",
            apiKey: "sk-test",
            model: "qwen3-asr-flash",
          },
        })
        await Config.reload("global")

        const log: CallLog = []
        Voice.setClientFactoryForTest(fakeClientFactory(log, { text: "你好世界" }))

        const result = await Voice.transcribe({
          data: new Uint8Array([9, 9]),
          context: "Previous conversation about Synergy voice input",
        })

        expect(result.text).toBe("你好世界")
        expect(log).toHaveLength(1)
        expect(log[0]!.model).toBe("qwen3-asr-flash")
        expect(log[0]!.baseURL).toBe("https://dashscope.example.com/compatible-mode/v1")
        const providerOptions = (log[0]!.args.providerOptions ?? {}) as Record<string, Record<string, unknown>>
        expect(providerOptions.openai?.prompt).toBe("Previous conversation about Synergy voice input")
        expect(providerOptions.openai?.language).toBeUndefined()
      },
    })
  })

  test("transcribe falls back to configured language and truncates long context", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await writeVoiceFragment({ stt: { model: "gpt-4o-transcribe", language: "zh" } })
        await Config.reload("global")

        const log: CallLog = []
        Voice.setClientFactoryForTest(fakeClientFactory(log, { text: "ok" }))

        const longContext = "x".repeat(2500)
        await Voice.transcribe({ data: new Uint8Array([1]), context: longContext })

        const providerOptions = (log[0]!.args.providerOptions ?? {}) as Record<string, Record<string, unknown>>
        expect((providerOptions.openai?.prompt as string).length).toBe(1000)
        expect(providerOptions.openai?.language).toBe("zh")
      },
    })
  })

  test("speak merges configured defaults with call overrides and returns audio bytes", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await writeVoiceFragment({
          tts: { model: "gpt-4o-mini-tts", voice: "alloy", instructions: "Speak calmly" },
        })
        await Config.reload("global")

        const log: CallLog = []
        const audioBytes = new Uint8Array([7, 7, 7])
        Voice.setClientFactoryForTest(fakeClientFactory(log, { audio: audioBytes }))

        const result = await Voice.speak({ text: "Report ready" })

        expect(Array.from(result.data)).toEqual([7, 7, 7])
        expect(result.mimeType).toBe("audio/mpeg")
        expect(log).toHaveLength(1)
        expect(log[0]!.model).toBe("gpt-4o-mini-tts")
        expect(log[0]!.args.text).toBe("Report ready")
        expect(log[0]!.args.voice).toBe("alloy")
        expect(log[0]!.args.instructions).toBe("Speak calmly")
        expect(log[0]!.baseURL).toBe("https://api.openai.com/v1")

        const overridden = await Voice.speak({ text: "Second", voice: "echo" })
        expect(Array.from(overridden.data)).toEqual([7, 7, 7])
        expect(log[1]!.args.voice).toBe("echo")
      },
    })
  })

  test("stt and tts enablement are independent", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await writeVoiceFragment({ stt: { model: "whisper-1" } })
        await Config.reload("global")

        expect(await Voice.sttEnabled()).toBe(true)
        expect(await Voice.ttsEnabled()).toBe(false)
      },
    })
  })
})
