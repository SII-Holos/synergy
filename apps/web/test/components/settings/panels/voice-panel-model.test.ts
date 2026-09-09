import { describe, expect, test } from "bun:test"
import type { VoiceConfig } from "@ericsanchezok/synergy-sdk/client"
import {
  buildVoiceConfigPatch,
  emptyVoiceDraft,
  hasStoredVoiceKey,
  voiceDraftFromConfig,
} from "../../../../src/components/settings/panels/voice-panel-model"

describe("voice panel model", () => {
  test("emptyVoiceDraft returns blank stt and tts drafts", () => {
    expect(emptyVoiceDraft()).toEqual({
      stt: { baseURL: "", apiKey: "", model: "", language: "" },
      tts: { baseURL: "", apiKey: "", model: "", voice: "", instructions: "" },
    })
  })

  test("voiceDraftFromConfig maps stored fields and never echoes api keys", () => {
    const draft = voiceDraftFromConfig({
      stt: { baseURL: "https://stt.example", apiKey: "sk-stt-stored", model: "asr-1", language: "zh" },
      tts: {
        baseURL: "https://tts.example",
        apiKey: "sk-tts-stored",
        model: "tts-1",
        voice: "v1",
        instructions: "slow",
      },
    } as VoiceConfig)

    expect(draft).toEqual({
      stt: { baseURL: "https://stt.example", apiKey: "", model: "asr-1", language: "zh" },
      tts: { baseURL: "https://tts.example", apiKey: "", model: "tts-1", voice: "v1", instructions: "slow" },
    })
    expect(voiceDraftFromConfig(undefined)).toEqual(emptyVoiceDraft())
  })

  test("hasStoredVoiceKey reports per-side secret presence without leaking it", () => {
    expect(hasStoredVoiceKey(undefined)).toEqual({ stt: false, tts: false })
    expect(hasStoredVoiceKey({ stt: { apiKey: "sk-stt-stored" } } as VoiceConfig)).toEqual({ stt: true, tts: false })
    expect(hasStoredVoiceKey({ tts: { apiKey: "sk-tts-stored" } } as VoiceConfig)).toEqual({ stt: false, tts: true })
  })

  test("buildVoiceConfigPatch returns undefined when the draft is untouched", () => {
    expect(buildVoiceConfigPatch(emptyVoiceDraft(), undefined)).toBeUndefined()
  })

  test("buildVoiceConfigPatch sends new api keys trimmed, per side", () => {
    const draft = emptyVoiceDraft()
    draft.stt.apiKey = "  sk-stt-new  "

    expect(buildVoiceConfigPatch(draft, undefined)).toEqual({ stt: { apiKey: "sk-stt-new" } })
  })

  test("buildVoiceConfigPatch writes changed fields and omits unchanged ones", () => {
    const loaded = { stt: { baseURL: "https://a.example", model: "m1", language: "zh" } } as VoiceConfig
    const draft = voiceDraftFromConfig(loaded)
    draft.stt.baseURL = "https://b.example"
    draft.stt.model = "m1"
    draft.stt.language = "en"

    expect(buildVoiceConfigPatch(draft, loaded)).toEqual({
      stt: { baseURL: "https://b.example", language: "en" },
    })
  })

  test("buildVoiceConfigPatch clears a model with an empty string and keeps cleared optionals", () => {
    const loaded = { stt: { baseURL: "https://a.example", model: "m1", language: "zh" } } as VoiceConfig
    const draft = voiceDraftFromConfig(loaded)
    draft.stt.model = ""
    draft.stt.baseURL = ""

    expect(buildVoiceConfigPatch(draft, loaded)).toEqual({ stt: { model: "" } })
  })

  test("buildVoiceConfigPatch treats whitespace as empty and merges both sides", () => {
    const draft = emptyVoiceDraft()
    draft.stt.model = "   "
    draft.tts.voice = " v1 "

    expect(buildVoiceConfigPatch(draft, undefined)).toEqual({ tts: { voice: "v1" } })
  })
})
