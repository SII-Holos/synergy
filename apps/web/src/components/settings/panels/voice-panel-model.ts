import type { VoiceConfig, VoiceSttConfig, VoiceTtsConfig } from "@ericsanchezok/synergy-sdk/client"

export type VoiceSttDraft = {
  enabled: boolean
  removeKey: boolean
  baseURL: string
  apiKey: string
  model: string
  language: string
}

export type VoiceTtsDraft = {
  enabled: boolean
  removeKey: boolean
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
    stt: { enabled: false, removeKey: false, baseURL: "", apiKey: "", model: "", language: "" },
    tts: { enabled: false, removeKey: false, baseURL: "", apiKey: "", model: "", voice: "", instructions: "" },
  }
}

export function voiceDraftFromConfig(config: VoiceConfig | undefined): VoiceDraft {
  const stt = config?.stt
  const tts = config?.tts
  return {
    stt: {
      enabled: stt?.enabled ?? Boolean(stt?.model?.trim()),
      removeKey: false,
      baseURL: stt?.baseURL ?? "",
      apiKey: "",
      model: stt?.model ?? "",
      language: stt?.language ?? "",
    },
    tts: {
      enabled: tts?.enabled ?? Boolean(tts?.model?.trim()),
      removeKey: false,
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
  if (draft.removeKey) patch.apiKey = null
  else if (apiKey) patch.apiKey = apiKey
  if (draft.enabled !== (loaded?.enabled ?? Boolean(loaded?.model?.trim()))) patch.enabled = draft.enabled
  const baseURL = draft.baseURL.trim()
  if (baseURL !== (loaded?.baseURL ?? "")) patch.baseURL = baseURL || null
  const model = draft.model.trim()
  if (model !== (loaded?.model ?? "")) {
    patch.model = model
    if (loaded?.enabled === undefined) patch.enabled = draft.enabled
  }
  const language = draft.language.trim()
  if (language !== (loaded?.language ?? "")) patch.language = language || null
  return Object.keys(patch).length ? patch : undefined
}

function buildTtsPatch(draft: VoiceTtsDraft, loaded: VoiceTtsConfig | undefined): VoiceTtsConfig | undefined {
  const patch: VoiceTtsConfig = {}
  const apiKey = draft.apiKey.trim()
  if (draft.removeKey) patch.apiKey = null
  else if (apiKey) patch.apiKey = apiKey
  if (draft.enabled !== (loaded?.enabled ?? Boolean(loaded?.model?.trim()))) patch.enabled = draft.enabled
  const baseURL = draft.baseURL.trim()
  if (baseURL !== (loaded?.baseURL ?? "")) patch.baseURL = baseURL || null
  const model = draft.model.trim()
  if (model !== (loaded?.model ?? "")) {
    patch.model = model
    if (loaded?.enabled === undefined) patch.enabled = draft.enabled
  }
  const voice = draft.voice.trim()
  if (voice !== (loaded?.voice ?? "")) patch.voice = voice || null
  const instructions = draft.instructions.trim()
  if (instructions !== (loaded?.instructions ?? "")) patch.instructions = instructions || null
  return Object.keys(patch).length ? patch : undefined
}
