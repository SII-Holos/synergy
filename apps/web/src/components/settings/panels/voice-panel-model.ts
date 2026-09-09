import type { VoiceConfig, VoiceSttConfig, VoiceTtsConfig } from "@ericsanchezok/synergy-sdk/client"

export type VoiceSttDraft = {
  baseURL: string
  apiKey: string
  model: string
  language: string
}

export type VoiceTtsDraft = {
  baseURL: string
  apiKey: string
  model: string
  voice: string
  instructions: string
}

export type VoiceDraft = {
  stt: VoiceSttDraft
  tts: VoiceTtsDraft
}

export function emptyVoiceDraft(): VoiceDraft {
  return {
    stt: { baseURL: "", apiKey: "", model: "", language: "" },
    tts: { baseURL: "", apiKey: "", model: "", voice: "", instructions: "" },
  }
}

/**
 * Stored API keys are never carried into the draft: the server has no
 * redaction sentinel for the voice domain, so echoing a key back would
 * overwrite the stored secret with its own plaintext value.
 */
export function voiceDraftFromConfig(config: VoiceConfig | undefined): VoiceDraft {
  const stt = config?.stt
  const tts = config?.tts
  return {
    stt: {
      baseURL: stt?.baseURL ?? "",
      apiKey: "",
      model: stt?.model ?? "",
      language: stt?.language ?? "",
    },
    tts: {
      baseURL: tts?.baseURL ?? "",
      apiKey: "",
      model: tts?.model ?? "",
      voice: tts?.voice ?? "",
      instructions: tts?.instructions ?? "",
    },
  }
}

export function hasStoredVoiceKey(config: VoiceConfig | undefined): { stt: boolean; tts: boolean } {
  return { stt: Boolean(config?.stt?.apiKey), tts: Boolean(config?.tts?.apiKey) }
}

/**
 * The voice domain merges deep and the SDK serializer drops undefined keys,
 * so a cleared model must be written as an empty string for the side to
 * disable. Other cleared optionals are omitted, which keeps their stored
 * value (the schema offers no null clear for them).
 */
export function buildVoiceConfigPatch(draft: VoiceDraft, config: VoiceConfig | undefined): VoiceConfig | undefined {
  const stt = buildSttPatch(draft.stt, config?.stt)
  const tts = buildTtsPatch(draft.tts, config?.tts)
  if (!stt && !tts) return undefined
  return {
    ...(stt ? { stt } : {}),
    ...(tts ? { tts } : {}),
  }
}

function buildSttPatch(draft: VoiceSttDraft, loaded: VoiceSttConfig | undefined): VoiceSttConfig | undefined {
  const patch: VoiceSttConfig = {}
  const apiKey = draft.apiKey.trim()
  if (apiKey) patch.apiKey = apiKey
  const baseURL = draft.baseURL.trim()
  if (baseURL && baseURL !== (loaded?.baseURL ?? "")) patch.baseURL = baseURL
  const model = draft.model.trim()
  if (model !== (loaded?.model ?? "")) patch.model = model
  const language = draft.language.trim()
  if (language && language !== (loaded?.language ?? "")) patch.language = language
  return Object.keys(patch).length ? patch : undefined
}

function buildTtsPatch(draft: VoiceTtsDraft, loaded: VoiceTtsConfig | undefined): VoiceTtsConfig | undefined {
  const patch: VoiceTtsConfig = {}
  const apiKey = draft.apiKey.trim()
  if (apiKey) patch.apiKey = apiKey
  const baseURL = draft.baseURL.trim()
  if (baseURL && baseURL !== (loaded?.baseURL ?? "")) patch.baseURL = baseURL
  const model = draft.model.trim()
  if (model !== (loaded?.model ?? "")) patch.model = model
  const voice = draft.voice.trim()
  if (voice && voice !== (loaded?.voice ?? "")) patch.voice = voice
  const instructions = draft.instructions.trim()
  if (instructions && instructions !== (loaded?.instructions ?? "")) patch.instructions = instructions
  return Object.keys(patch).length ? patch : undefined
}
