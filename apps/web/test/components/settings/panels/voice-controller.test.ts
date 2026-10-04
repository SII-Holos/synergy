import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { VoiceConfig } from "@ericsanchezok/synergy-sdk/client"
import { createVoiceController } from "../../../../src/components/settings/panels/voice-controller"

const initial: VoiceConfig = { stt: { model: "whisper-1", apiKey: "***", language: "zh" } }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function withController(
  api: Parameters<typeof createVoiceController>[0],
  run: (controller: ReturnType<typeof createVoiceController>) => Promise<void>,
) {
  return createRoot((dispose) => Promise.resolve(run(createVoiceController(api))).finally(dispose))
}

describe("voice settings controller", () => {
  test("filling a model does not enable an unconfigured speech capability", async () => {
    let config: VoiceConfig
    await withController(
      {
        get: async () => config,
        update: async (patch) => {
          config = { stt: { ...config?.stt, ...patch?.stt }, tts: { ...config?.tts, ...patch?.tts } }
          return config
        },
      },
      async (controller) => {
        await controller.load()
        controller.setDraft("stt", "model", "whisper-1")
        controller.setDraft("tts", "model", "gpt-4o-mini-tts")
        expect(await controller.save()).toBe(true)
        await controller.load()
        expect(controller.draft.stt.enabled).toBe(false)
        expect(controller.draft.tts.enabled).toBe(false)
        expect(controller.config()?.stt?.model).toBe("whisper-1")
        expect(controller.config()?.tts?.model).toBe("gpt-4o-mini-tts")
        expect(controller.dirty()).toBe(false)
      },
    )
  })
  test("an explicit enabled flag remains visible when its model needs repair", async () => {
    await withController(
      { get: async () => ({ stt: { enabled: true } }), update: async () => undefined },
      async (controller) => {
        await controller.load()
        expect(controller.draft.stt.enabled).toBe(true)
        expect(controller.validate()?.field).toBe("model")
        expect(controller.dirty()).toBe(false)
      },
    )
  })
  test("background reads preserve edits and adopt unrelated saved changes", async () => {
    let config = initial
    await withController({ get: async () => config, update: async () => config }, async (controller) => {
      await controller.load()
      expect(controller.dirty()).toBe(false)
      controller.setDraft("stt", "model", "edited-model")
      config = { ...initial, tts: { enabled: true, model: "saved-tts" } }
      await controller.load()
      expect(controller.draft.stt.model).toBe("edited-model")
      expect(controller.draft.tts.model).toBe("saved-tts")
      expect(controller.draft.stt.apiKey).toBe("")
      expect(controller.dirty()).toBe(true)
      controller.discard()
      expect(controller.draft.stt.model).toBe("whisper-1")
    })
  })
  test("save acknowledges only the submitted snapshot, including secret replacement", async () => {
    const pending = deferred<VoiceConfig>()
    const changes: VoiceConfig[] = []
    await withController(
      {
        get: async () => initial,
        update: async (patch) => {
          changes.push(patch)
          return pending.promise
        },
      },
      async (controller) => {
        await controller.load()
        controller.setDraft("stt", "model", "submitted-model")
        controller.setDraft("stt", "apiKey", "replacement")
        const saving = controller.save()
        expect(controller.status()).toBe("saving")
        expect(await controller.save()).toBe(false)
        controller.setDraft("stt", "model", "later-model")
        controller.setDraft("stt", "apiKey", "later-key")
        pending.resolve({ stt: { ...initial.stt, model: "submitted-model" } })
        expect(await saving).toBe(true)
        expect(changes).toEqual([{ stt: { model: "submitted-model", apiKey: "replacement", enabled: true } }])
        expect(controller.draft.stt.model).toBe("later-model")
        expect(controller.draft.stt.apiKey).toBe("later-key")
        expect(controller.dirty()).toBe(true)
      },
    )
  })
  test("failed writes retain drafts and validation prevents any write", async () => {
    let writes = 0
    await withController(
      {
        get: async () => initial,
        update: async () => {
          writes++
          throw new Error("service unavailable")
        },
      },
      async (controller) => {
        await controller.load()
        controller.setDraft("stt", "model", "")
        expect(controller.validate()).toEqual({ side: "stt", field: "model", reason: "model" })
        expect(await controller.save()).toBe(false)
        expect(writes).toBe(0)
        controller.setDraft("stt", "enabled", false)
        expect(await controller.save()).toBe(false)
        expect(writes).toBe(1)
        expect(controller.error()).toBe("service unavailable")
        expect(controller.dirty()).toBe(true)
      },
    )
  })
  test("blank secrets are retained and explicit removal survives reload", async () => {
    let config = initial
    const changes: VoiceConfig[] = []
    await withController(
      {
        get: async () => config,
        update: async (patch) => {
          changes.push(patch)
          config = { stt: { ...config.stt, ...patch.stt } }
          return config
        },
      },
      async (controller) => {
        await controller.load()
        controller.setDraft("stt", "language", "")
        expect(await controller.save()).toBe(true)
        expect(changes[0]).toEqual({ stt: { language: null } })
        controller.setDraft("stt", "removeKey", true)
        expect(await controller.save()).toBe(true)
        expect(changes[1]).toEqual({ stt: { apiKey: null } })
        await controller.load()
        expect(controller.config()?.stt?.apiKey).toBeNull()
        expect(controller.draft.stt.removeKey).toBe(false)
        expect(controller.dirty()).toBe(false)
      },
    )
  })
})
