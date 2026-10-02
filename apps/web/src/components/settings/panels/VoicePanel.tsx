import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { requestErrorMessage } from "@/utils/error"
import {
  createVoiceDictationEngine,
  isMicSilenceReason,
  isNoSpeechReason,
  type VoiceDictationPhase,
} from "@/components/prompt-input/voice-dictation-core"
import { normalizeDictationBlob } from "@/components/prompt-input/voice-dictation-audio"
import { createDictationRecorder, decodeDictationAudio } from "@/components/prompt-input/voice-dictation-browser"
import { PasswordField } from "../components/PasswordField"
import { SettingsPage, SettingsSection, SettingsAdvanced } from "../components/SettingsPrimitives"
import { SettingRow } from "../components/SettingsSettingRow"
import { useSettingsViewState } from "../settings-view-state"
import { hasStoredVoiceKey } from "./voice-panel-model"
import type { VoiceController } from "./voice-controller"

const copy = {
  title: { id: "settings.voice.page.title", message: "Voice" },
  description: { id: "settings.voice.page.description", message: "Speak to Synergy and listen to answers." },
  stt: { id: "settings.voice.stt.title", message: "Voice input" },
  tts: { id: "settings.voice.tts.title", message: "Read answers aloud" },
  sttHint: { id: "settings.voice.stt.description", message: "Turn microphone recordings into text." },
  ttsHint: { id: "settings.voice.tts.description", message: "Allow Synergy to read text using your speech service." },
  template: { id: "settings.voice.template", message: "Service" },
  compatible: { id: "settings.voice.template.compatible", message: "Custom compatible service" },
  model: { id: "settings.voice.model", message: "Model" },
  modelHint: { id: "settings.voice.model.hint", message: "Enter an audio model ID supported by this service." },
  key: { id: "settings.voice.key", message: "API key" },
  configured: { id: "settings.voice.key.configured", message: "Configured" },
  removing: { id: "settings.voice.key.removing", message: "Will be removed on save" },
  replace: { id: "settings.voice.key.replace", message: "Replace key" },
  remove: { id: "settings.voice.key.remove", message: "Remove key" },
  undo: { id: "settings.voice.key.undo", message: "Keep existing key" },
  keyHint: { id: "settings.voice.key.hint", message: "Leave the replacement empty to keep your existing key." },
  advanced: { id: "settings.voice.advanced", message: "Advanced options" },
  endpoint: { id: "settings.voice.endpoint", message: "API endpoint" },
  default: { id: "settings.voice.default", message: "Use default" },
  language: { id: "settings.voice.language", message: "Recognition language" },
  languageHint: {
    id: "settings.voice.language.hint",
    message: "Leave empty to detect automatically, or enter a language code such as zh or en.",
  },
  voice: { id: "settings.voice.voice", message: "Voice" },
  instructions: { id: "settings.voice.instructions", message: "Delivery instructions" },
  modelRequired: { id: "settings.voice.validation.model", message: "Enter a model before enabling this capability." },
  invalidEndpoint: { id: "settings.voice.validation.endpoint", message: "Enter a valid HTTP or HTTPS endpoint." },
  test: { id: "settings.voice.test.record", message: "Test microphone" },
  stop: { id: "settings.voice.test.stop", message: "Stop" },
  transcribing: { id: "settings.voice.test.transcribing", message: "Transcribing…" },
  audition: { id: "settings.voice.test.preview", message: "Preview voice" },
  generating: { id: "settings.voice.test.generating", message: "Generating audio…" },
  sample: { id: "settings.voice.test.sample", message: "Hello, this is Synergy. Your voice preview is ready." },
  dirty: { id: "settings.voice.test.saveFirst", message: "Save your voice changes before testing." },
  destination: {
    id: "settings.voice.test.destination",
    message:
      "Microphone testing sends audio to {endpoint} and requires microphone permission. Your service may charge for usage.",
  },
  previewDestination: {
    id: "settings.voice.test.previewDestination",
    message: "Preview sends sample text to {endpoint}. Your service may charge for usage.",
  },
  permission: {
    id: "settings.voice.test.permission",
    message: "Microphone permission was denied. Allow microphone access in your browser and try again.",
  },
  unsupported: {
    id: "settings.voice.test.unsupported",
    message: "This browser does not support microphone recording.",
  },
  silence: {
    id: "settings.voice.test.silence",
    message: "No speech was detected. Check your microphone and try again.",
  },
  retry: { id: "settings.voice.load.retry", message: "Retry" },
  loading: { id: "settings.voice.loading", message: "Loading voice settings…" },
  stopped: { id: "settings.voice.test.stopped", message: "Test stopped." },
  failed: {
    id: "settings.voice.test.failed",
    message: "The voice test failed. Check your service settings and try again.",
  },
}

export function VoicePanel(props: { controller: VoiceController; searchField?: string }) {
  const { _ } = useLingui()
  const sdk = useGlobalSDK()
  const controller = props.controller
  const viewState = useSettingsViewState()
  const [replacing, setReplacing] = createSignal<string>()
  const [phase, setPhase] = createSignal<VoiceDictationPhase>("idle")
  const [transcript, setTranscript] = createSignal("")
  const [testError, setTestError] = createSignal("")
  const [previewBusy, setPreviewBusy] = createSignal(false)
  const [audioURL, setAudioURL] = createSignal<string>()
  let abort: AbortController | undefined
  let player: HTMLAudioElement | undefined
  let disposed = false
  let recordingVersion = 0
  const savedEnabled = (side: "stt" | "tts") =>
    controller.config()?.[side]?.enabled !== false && Boolean(controller.config()?.[side]?.model?.trim())
  const busy = () => phase() !== "idle" || previewBusy()
  const testBlocked = () => controller.dirty() || controller.status() === "saving" || !controller.loaded()
  const createEngine = () =>
    createVoiceDictationEngine({
      isConfigured: () => savedEnabled("stt"),
      openSettings: () => {},
      getContext: () => "",
      insertText: setTranscript,
      hasGetUserMedia: () => Boolean(navigator.mediaDevices?.getUserMedia),
      requestMicrophone: () => navigator.mediaDevices.getUserMedia({ audio: true }),
      hasMediaRecorder: () => typeof MediaRecorder !== "undefined",
      isTypeSupported: (type) => MediaRecorder.isTypeSupported(type),
      createRecorder: createDictationRecorder,
      nowMs: () => Date.now(),
      transcribe: async (input) => {
        const version = recordingVersion
        const prepared = await normalizeDictationBlob(input.file, decodeDictationAudio)
        if (disposed || version !== recordingVersion) throw new DOMException("Test stopped", "AbortError")
        if (prepared.kind === "silence") throw Object.assign(new Error("No audio"), { reason: "voice_mic_silence" })
        abort = new AbortController()
        const response = await sdk.client.voice.transcribe(
          { file: prepared.file },
          { throwOnError: true, signal: abort.signal },
        )
        return { text: response.data?.text ?? "" }
      },
      report: (report) => {
        if (report.kind === "permission-denied") setTestError(_(copy.permission))
        else if (report.kind === "unsupported") setTestError(_(copy.unsupported))
        else
          setTestError(
            isMicSilenceReason(report.error) || isNoSpeechReason(report.error)
              ? _(copy.silence)
              : requestErrorMessage(report.error, _(copy.failed)),
          )
      },
      onPhaseChange: setPhase,
    })
  let engine = createEngine()
  function cancelRecording() {
    recordingVersion++
    abort?.abort()
    engine.dispose()
    engine = createEngine()
    setPhase("idle")
    setTestError(_(copy.stopped))
  }
  function releaseAudio() {
    player?.pause()
    const url = audioURL()
    if (url) URL.revokeObjectURL(url)
    setAudioURL(undefined)
  }
  function stopPreview() {
    abort?.abort()
    setPreviewBusy(false)
    releaseAudio()
  }
  const onEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || (!busy() && !audioURL())) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (phase() !== "idle") cancelRecording()
    stopPreview()
  }
  window.addEventListener("keydown", onEscape, true)
  onCleanup(() => {
    window.removeEventListener("keydown", onEscape, true)
    disposed = true
    recordingVersion++
    engine.dispose()
    stopPreview()
  })
  async function preview() {
    if (testBlocked() || busy() || !savedEnabled("tts")) return
    releaseAudio()
    setTestError("")
    const request = new AbortController()
    abort = request
    setPreviewBusy(true)
    try {
      const response = await sdk.client.voice.preview(
        { voicePreviewInput: { text: _(copy.sample) } },
        { throwOnError: true, parseAs: "blob", signal: request.signal },
      )
      if (disposed || request.signal.aborted) return
      const data: unknown = response.data
      if (!(data instanceof Blob)) throw new Error(_(copy.failed))
      setAudioURL(URL.createObjectURL(data))
    } catch (cause) {
      if (!request.signal.aborted) setTestError(requestErrorMessage(cause, _(copy.failed)))
    } finally {
      if (abort === request) setPreviewBusy(false)
    }
  }
  return (
    <div>
      <SettingsPage title={_(copy.title)} description={_(copy.description)}>
        <Show when={controller.status() === "loading" && !controller.loaded()}>
          <p role="status">{_(copy.loading)}</p>
        </Show>
        <Show when={controller.error()}>
          <div class="settings-request-error" role="alert">
            {controller.error()}
            <Button onClick={() => void controller.load()}>{_(copy.retry)}</Button>
          </div>
        </Show>
        <For each={["stt", "tts"] as const}>
          {(side) => {
            const [editing, setEditing] = createSignal(viewState?.expanded(`configure:${side}`) ?? false)
            const ability = () => _(side === "stt" ? copy.stt : copy.tts)
            const contextLabel = (label: { id: string; message: string }) =>
              _({
                id: "settings.voice.field.context",
                message: "{ability}: {field}",
                values: { ability: ability(), field: _(label) },
              })
            const edit = (open: boolean) => {
              setEditing(open)
              viewState?.setExpanded(`configure:${side}`, open)
              if (!open) {
                if (side === "stt") {
                  if (phase() !== "idle") cancelRecording()
                } else stopPreview()
              }
            }
            const value = () => controller.draft[side]
            const storedKey = () => hasStoredVoiceKey(controller.config())[side]
            const validation = () => controller.validate()
            const fieldError = (field: string) =>
              validation()?.side === side && validation()?.field === field
                ? _(validation()?.reason === "model" ? copy.modelRequired : copy.invalidEndpoint)
                : undefined
            const formOpen = () => value().enabled || editing() || validation()?.side === side
            createEffect(() => {
              if (props.searchField?.startsWith(ability())) edit(true)
            })
            return (
              <SettingsSection
                title={side === "stt" ? _(copy.stt) : _(copy.tts)}
                description={_(side === "stt" ? copy.sttHint : copy.ttsHint)}
                actions={
                  <Switch
                    checked={value().enabled}
                    onChange={(enabled) => {
                      controller.setDraft(side, "enabled", enabled)
                      if (!enabled) {
                        if (side === "stt") {
                          if (phase() !== "idle") cancelRecording()
                        } else stopPreview()
                      }
                    }}
                    aria-label={side === "stt" ? _(copy.stt) : _(copy.tts)}
                  />
                }
              >
                <Show when={!formOpen()}>
                  <Show when={value().model.trim()}>
                    <p class="settings-row-description">
                      {_({
                        id: "settings.voice.summary",
                        message: "{service} · {model}",
                        values: {
                          service: value().baseURL.trim() ? _(copy.compatible) : "OpenAI",
                          model: value().model,
                        },
                      })}
                    </p>
                  </Show>
                  <Button variant="ghost" onClick={() => edit(true)}>
                    {_({
                      id: "settings.voice.configure",
                      message: "Configure {ability}",
                      values: { ability: ability() },
                    })}
                  </Button>
                </Show>
                <Show when={formOpen()}>
                  <Show when={editing() && !value().enabled}>
                    <Button variant="ghost" size="small" onClick={() => edit(false)}>
                      {_({
                        id: "settings.voice.doneEditing",
                        message: "Done editing {ability}",
                        values: { ability: ability() },
                      })}
                    </Button>
                  </Show>
                  <SettingRow
                    title={_(copy.template)}
                    description=""
                    trailing={
                      <select
                        class="settings-native-select"
                        aria-label={contextLabel(copy.template)}
                        value={
                          value().baseURL.trim() && value().baseURL.trim() !== "https://api.openai.com/v1"
                            ? "custom"
                            : "openai"
                        }
                        onChange={(event) =>
                          controller.setDraft(side, "baseURL", event.currentTarget.value === "openai" ? "" : "https://")
                        }
                      >
                        <option value="openai">OpenAI</option>
                        <option value="custom">{_(copy.compatible)}</option>
                      </select>
                    }
                  />
                  <SettingRow
                    title={_(copy.model) + (value().enabled ? " *" : "")}
                    description={_(copy.modelHint)}
                    trailing={
                      <TextField
                        label={contextLabel(copy.model)}
                        hideLabel
                        required={value().enabled}
                        value={value().model}
                        validationState={fieldError("model") ? "invalid" : "valid"}
                        error={fieldError("model")}
                        placeholder={side === "stt" ? "gpt-4o-mini-transcribe" : "gpt-4o-mini-tts"}
                        onChange={(model) => controller.setDraft(side, "model", model)}
                      />
                    }
                  />
                  <SettingRow
                    title={_(copy.key)}
                    description={
                      storedKey()
                        ? _(copy.keyHint)
                        : _({ id: "settings.voice.key.newHint", message: "API key for this audio service." })
                    }
                    trailing={
                      <div class="settings-key-control">
                        <Show
                          when={!storedKey() || replacing() === side}
                          fallback={
                            <span class="ds-inline-badge ds-inline-badge-muted">
                              {_(value().removeKey ? copy.removing : copy.configured)}
                            </span>
                          }
                        >
                          <PasswordField
                            label={contextLabel(copy.key)}
                            value={value().apiKey}
                            onChange={(key) => {
                              controller.setDraft(side, "apiKey", key)
                              controller.setDraft(side, "removeKey", false)
                            }}
                          />
                        </Show>
                        <Show when={storedKey()}>
                          <Button variant="ghost" size="small" onClick={() => setReplacing(side)}>
                            {_(copy.replace)}
                          </Button>
                          <Button
                            variant="ghost"
                            size="small"
                            onClick={() => controller.setDraft(side, "removeKey", !value().removeKey)}
                          >
                            {_(value().removeKey ? copy.undo : copy.remove)}
                          </Button>
                        </Show>
                      </div>
                    }
                  />
                  <SettingsAdvanced
                    id={side}
                    title={_(copy.advanced)}
                    fields={[copy.endpoint, copy.language, copy.voice, copy.instructions].map(contextLabel)}
                    forceOpen={Boolean(fieldError("baseURL")) || value().baseURL === "https://"}
                  >
                    <SettingRow
                      title={_(copy.endpoint)}
                      description=""
                      trailing={
                        <div class="settings-field-action">
                          <TextField
                            label={contextLabel(copy.endpoint)}
                            hideLabel
                            value={value().baseURL}
                            validationState={fieldError("baseURL") ? "invalid" : "valid"}
                            error={fieldError("baseURL")}
                            placeholder="https://api.openai.com/v1"
                            onChange={(url) => controller.setDraft(side, "baseURL", url)}
                          />
                          <Button variant="ghost" size="small" onClick={() => controller.setDraft(side, "baseURL", "")}>
                            {_(copy.default)}
                          </Button>
                        </div>
                      }
                    />
                    <Show
                      when={side === "stt"}
                      fallback={
                        <>
                          <SettingRow
                            title={_(copy.voice)}
                            description=""
                            trailing={
                              <TextField
                                label={contextLabel(copy.voice)}
                                hideLabel
                                value={controller.draft.tts.voice}
                                onChange={(voice) => controller.setDraft("tts", "voice", voice)}
                              />
                            }
                          />
                          <SettingRow
                            title={_(copy.instructions)}
                            description=""
                            trailing={
                              <TextField
                                label={contextLabel(copy.instructions)}
                                hideLabel
                                value={controller.draft.tts.instructions}
                                onChange={(instructions) => controller.setDraft("tts", "instructions", instructions)}
                              />
                            }
                          />
                        </>
                      }
                    >
                      <SettingRow
                        title={_(copy.language)}
                        description={_(copy.languageHint)}
                        trailing={
                          <TextField
                            label={contextLabel(copy.language)}
                            hideLabel
                            value={controller.draft.stt.language}
                            onChange={(language) => controller.setDraft("stt", "language", language)}
                          />
                        }
                      />
                    </Show>
                  </SettingsAdvanced>
                  <div class="settings-voice-test">
                    <Show when={!controller.dirty() && !savedEnabled(side)}>
                      <p class="ds-section-hint">
                        {_({
                          id: "settings.voice.test.enableFirst",
                          message: "Enable this capability, complete its model configuration, and save before testing.",
                        })}
                      </p>
                    </Show>
                    <p class="ds-section-hint">
                      {_({
                        ...(side === "stt" ? copy.destination : copy.previewDestination),
                        values: { endpoint: controller.config()?.[side]?.baseURL || "https://api.openai.com/v1" },
                      })}
                    </p>
                    <Show when={controller.dirty()}>
                      <p class="ds-section-hint">{_(copy.dirty)}</p>
                    </Show>
                    <Show
                      when={side === "stt"}
                      fallback={
                        <div class="settings-test-actions">
                          <Button
                            variant="secondary"
                            disabled={testBlocked() || busy() || !savedEnabled("tts")}
                            onClick={() => void preview()}
                          >
                            {previewBusy() ? _(copy.generating) : _(copy.audition)}
                          </Button>
                          <Show when={previewBusy() || audioURL()}>
                            <Button variant="ghost" onClick={stopPreview}>
                              {_(copy.stop)}
                            </Button>
                          </Show>
                          <Show when={audioURL()}>
                            {(url) => <audio ref={player} controls src={url()} aria-label={_(copy.audition)} />}
                          </Show>
                        </div>
                      }
                    >
                      <Button
                        variant="secondary"
                        disabled={testBlocked() || !savedEnabled("stt") || previewBusy() || phase() === "transcribing"}
                        onClick={() => {
                          setTestError("")
                          if (phase() === "recording") engine.stop()
                          else {
                            setTranscript("")
                            engine.start()
                          }
                        }}
                      >
                        {phase() === "recording"
                          ? _(copy.stop)
                          : phase() === "transcribing"
                            ? _(copy.transcribing)
                            : _(copy.test)}
                      </Button>
                      <Show when={phase() === "transcribing"}>
                        <Button variant="ghost" onClick={cancelRecording}>
                          {_(copy.stop)}
                        </Button>
                      </Show>
                      <Show when={transcript()}>
                        <p class="settings-transcript" role="status">
                          {transcript()}
                        </p>
                      </Show>
                    </Show>
                  </div>
                </Show>
              </SettingsSection>
            )
          }}
        </For>
        <Show when={testError()}>
          <p class="settings-request-error" role="alert">
            {testError()}
          </p>
        </Show>
      </SettingsPage>
    </div>
  )
}
