import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { createEffect, createMemo, createResource, createSignal, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobalSDK } from "@/context/global-sdk"
import { requestErrorMessage } from "@/utils/error"
import { PasswordField } from "../components/PasswordField"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import { SettingRow } from "../components/SettingRow"
import {
  buildVoiceConfigPatch,
  emptyVoiceDraft,
  hasStoredVoiceKey,
  voiceDraftFromConfig,
  type VoiceDraft,
} from "./voice-panel-model"

const copy = {
  title: { id: "settings.voice.page.title", message: "Voice" },
  description: {
    id: "settings.voice.page.description",
    message: "Configure OpenAI-compatible speech-to-text and text-to-speech endpoints.",
  },
  sttTitle: { id: "settings.voice.stt.title", message: "Speech recognition (STT)" },
  sttDescription: {
    id: "settings.voice.stt.description",
    message:
      "Any OpenAI-compatible endpoint works, e.g. DashScope qwen3-asr-flash supports Chinese dialect recognition. Voice dictation is disabled when the model is empty.",
  },
  sttBaseURLTitle: { id: "settings.voice.stt.baseURL.title", message: "Base URL" },
  sttBaseURLDescription: {
    id: "settings.voice.stt.baseURL.description",
    message: "Speech-to-text endpoint. Leave empty for the OpenAI default.",
  },
  sttBaseURLPlaceholder: { id: "settings.voice.stt.baseURL.placeholder", message: "https://api.openai.com/v1" },
  sttApiKeyTitle: { id: "settings.voice.stt.apiKey.title", message: "API Key" },
  sttApiKeyDescription: {
    id: "settings.voice.stt.apiKey.description",
    message: "API key for the speech-to-text service.",
  },
  sttModelTitle: { id: "settings.voice.stt.model.title", message: "Model" },
  sttModelDescription: {
    id: "settings.voice.stt.model.description",
    message: "Speech-to-text model, e.g. gpt-4o-mini-transcribe.",
  },
  sttModelPlaceholder: { id: "settings.voice.stt.model.placeholder", message: "gpt-4o-mini-transcribe" },
  sttLanguageTitle: { id: "settings.voice.stt.language.title", message: "Language (optional)" },
  sttLanguageDescription: {
    id: "settings.voice.stt.language.description",
    message: "BCP-47 language hint for transcription, e.g. zh or en. Auto-detected when empty.",
  },
  sttLanguagePlaceholder: { id: "settings.voice.stt.language.placeholder", message: "zh" },
  ttsTitle: { id: "settings.voice.tts.title", message: "Speech synthesis (TTS)" },
  ttsDescription: {
    id: "settings.voice.tts.description",
    message:
      "Any OpenAI-compatible endpoint works, e.g. DashScope cosyvoice-v3-flash. The speak tool is disabled when the model is empty.",
  },
  ttsBaseURLTitle: { id: "settings.voice.tts.baseURL.title", message: "Base URL" },
  ttsBaseURLDescription: {
    id: "settings.voice.tts.baseURL.description",
    message: "Text-to-speech endpoint. Leave empty for the OpenAI default.",
  },
  ttsBaseURLPlaceholder: { id: "settings.voice.tts.baseURL.placeholder", message: "https://api.openai.com/v1" },
  ttsApiKeyTitle: { id: "settings.voice.tts.apiKey.title", message: "API Key" },
  ttsApiKeyDescription: {
    id: "settings.voice.tts.apiKey.description",
    message: "API key for the text-to-speech service.",
  },
  ttsModelTitle: { id: "settings.voice.tts.model.title", message: "Model" },
  ttsModelDescription: {
    id: "settings.voice.tts.model.description",
    message: "Text-to-speech model, e.g. gpt-4o-mini-tts.",
  },
  ttsModelPlaceholder: { id: "settings.voice.tts.model.placeholder", message: "gpt-4o-mini-tts" },
  ttsVoiceTitle: { id: "settings.voice.tts.voice.title", message: "Voice" },
  ttsVoiceDescription: {
    id: "settings.voice.tts.voice.description",
    message: "Voice name for synthesis, e.g. alloy. Provider-specific.",
  },
  ttsVoicePlaceholder: { id: "settings.voice.tts.voice.placeholder", message: "alloy" },
  ttsInstructionsTitle: { id: "settings.voice.tts.instructions.title", message: "Instructions (optional)" },
  ttsInstructionsDescription: {
    id: "settings.voice.tts.instructions.description",
    message: "Natural-language delivery instructions such as tone and pace.",
  },
  apiKeySaved: { id: "settings.voice.apiKey.saved", message: "Saved" },
  save: { id: "settings.voice.save", message: "Save" },
  saving: { id: "settings.voice.saving", message: "Saving..." },
  cancel: { id: "settings.voice.cancel", message: "Cancel" },
  loadError: { id: "settings.voice.load.error", message: "Voice settings could not be loaded." },
  retry: { id: "settings.voice.load.retry", message: "Retry" },
  savedTitle: { id: "settings.voice.saved.title", message: "Voice settings saved" },
  savedDescription: { id: "settings.voice.saved.description", message: "Voice configuration was updated." },
  saveFailedTitle: { id: "settings.voice.saveFailed.title", message: "Voice settings could not be saved" },
  saveFailedDescription: {
    id: "settings.voice.saveFailed.description",
    message: "Unable to update the voice configuration.",
  },
}

export function VoicePanel() {
  const { _ } = useLingui()
  const globalSDK = useGlobalSDK()
  const [config, { refetch }] = createResource(async () => {
    const response = await globalSDK.client.config.domain.get({ domain: "voice" }, { throwOnError: true })
    return response.data
  })
  const [draft, setDraft] = createStore<VoiceDraft>(emptyVoiceDraft())
  const [adopted, setAdopted] = createSignal(false)
  const [saving, setSaving] = createSignal(false)

  createEffect(() => {
    if (config.loading) return
    setDraft(voiceDraftFromConfig(config()?.voice))
    setAdopted(true)
  })

  const storedKeys = createMemo(() => hasStoredVoiceKey(config()?.voice))
  const voicePatch = createMemo(() => buildVoiceConfigPatch(draft, config()?.voice))
  const dirty = createMemo(() => Boolean(adopted() && voicePatch()))
  const busy = () => saving() || config.loading

  function cancel() {
    if (config.loading) return
    setDraft(voiceDraftFromConfig(config()?.voice))
  }

  async function save() {
    const voice = voicePatch()
    if (!voice || busy()) return
    setSaving(true)
    try {
      await globalSDK.client.config.domain.update(
        { domain: "voice", configDomainUpdateInput: { config: { voice } } },
        { throwOnError: true },
      )
      await refetch()
      showToast({ type: "success", title: _(copy.savedTitle), description: _(copy.savedDescription) })
    } catch (error) {
      showToast({
        type: "error",
        title: _(copy.saveFailedTitle),
        description: requestErrorMessage(error, _(copy.saveFailedDescription)),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsPage
      title={_(copy.title)}
      description={_(copy.description)}
      actions={
        <div class="flex items-center gap-2">
          <Button type="button" variant="ghost" size="small" disabled={!dirty() || busy()} onClick={cancel}>
            {_(copy.cancel)}
          </Button>
          <Button
            type="button"
            variant="primary"
            size="small"
            icon={getSemanticIcon("state.success")}
            disabled={!dirty() || busy()}
            onClick={() => void save()}
          >
            {saving() ? _(copy.saving) : _(copy.save)}
          </Button>
        </div>
      }
    >
      <Show when={config.error}>
        <div class="settings-request-error" role="alert">
          <Icon name={getSemanticIcon("state.error")} size="small" />
          <span>{_(copy.loadError)}</span>
          <Button type="button" variant="secondary" size="small" onClick={() => void refetch()}>
            {_(copy.retry)}
          </Button>
        </div>
      </Show>

      <SettingsSection title={_(copy.sttTitle)} description={_(copy.sttDescription)}>
        <SettingRow
          title={_(copy.sttBaseURLTitle)}
          description={_(copy.sttBaseURLDescription)}
          trailing={
            <TextField
              type="text"
              placeholder={_(copy.sttBaseURLPlaceholder)}
              value={draft.stt.baseURL}
              onChange={(value) => setDraft("stt", "baseURL", value)}
            />
          }
        />
        <SettingRow
          title={_(copy.sttApiKeyTitle)}
          description={_(copy.sttApiKeyDescription)}
          trailing={
            <PasswordField
              label={_(copy.sttApiKeyTitle)}
              value={draft.stt.apiKey}
              placeholder={storedKeys().stt ? _(copy.apiKeySaved) : undefined}
              onChange={(value) => setDraft("stt", "apiKey", value)}
            />
          }
        />
        <SettingRow
          title={_(copy.sttModelTitle)}
          description={_(copy.sttModelDescription)}
          trailing={
            <TextField
              type="text"
              placeholder={_(copy.sttModelPlaceholder)}
              value={draft.stt.model}
              onChange={(value) => setDraft("stt", "model", value)}
            />
          }
        />
        <SettingRow
          title={_(copy.sttLanguageTitle)}
          description={_(copy.sttLanguageDescription)}
          trailing={
            <TextField
              type="text"
              placeholder={_(copy.sttLanguagePlaceholder)}
              value={draft.stt.language}
              onChange={(value) => setDraft("stt", "language", value)}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={_(copy.ttsTitle)} description={_(copy.ttsDescription)}>
        <SettingRow
          title={_(copy.ttsBaseURLTitle)}
          description={_(copy.ttsBaseURLDescription)}
          trailing={
            <TextField
              type="text"
              placeholder={_(copy.ttsBaseURLPlaceholder)}
              value={draft.tts.baseURL}
              onChange={(value) => setDraft("tts", "baseURL", value)}
            />
          }
        />
        <SettingRow
          title={_(copy.ttsApiKeyTitle)}
          description={_(copy.ttsApiKeyDescription)}
          trailing={
            <PasswordField
              label={_(copy.ttsApiKeyTitle)}
              value={draft.tts.apiKey}
              placeholder={storedKeys().tts ? _(copy.apiKeySaved) : undefined}
              onChange={(value) => setDraft("tts", "apiKey", value)}
            />
          }
        />
        <SettingRow
          title={_(copy.ttsModelTitle)}
          description={_(copy.ttsModelDescription)}
          trailing={
            <TextField
              type="text"
              placeholder={_(copy.ttsModelPlaceholder)}
              value={draft.tts.model}
              onChange={(value) => setDraft("tts", "model", value)}
            />
          }
        />
        <SettingRow
          title={_(copy.ttsVoiceTitle)}
          description={_(copy.ttsVoiceDescription)}
          trailing={
            <TextField
              type="text"
              placeholder={_(copy.ttsVoicePlaceholder)}
              value={draft.tts.voice}
              onChange={(value) => setDraft("tts", "voice", value)}
            />
          }
        />
        <SettingRow
          title={_(copy.ttsInstructionsTitle)}
          description={_(copy.ttsInstructionsDescription)}
          trailing={
            <TextField
              type="text"
              multiline
              class="settings-row-control-text"
              value={draft.tts.instructions}
              onChange={(value) => setDraft("tts", "instructions", value)}
            />
          }
        />
      </SettingsSection>
    </SettingsPage>
  )
}
