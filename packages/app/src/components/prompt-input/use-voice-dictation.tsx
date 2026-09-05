import { createEffect, createSignal, onCleanup, Switch, Match } from "solid-js"
import type { MessageDescriptor } from "@lingui/core"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useSDK } from "@/context/sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLocale } from "@/context/locale"
import { SettingsDialog } from "@/components/settings"
import { requestErrorMessage } from "@/utils/error"
import { PI } from "./prompt-input-i18n"
import { normalizeDictationBlob, type DecodedAudio } from "./voice-dictation-audio"
import {
  createVoiceDictationEngine,
  isMicSilenceReason,
  isNoSpeechReason,
  isSttConfigured,
  type VoiceDictationDependencies,
  type VoiceDictationPhase,
  type VoiceDictationRecorderHandlers,
  type VoiceDictationReport,
  type VoiceDictationStream,
} from "./voice-dictation-core"

/** Decode a recorded blob to mono Float32 via the lightweight offline context. */
async function decodeDictationAudio(arrayBuffer: ArrayBuffer): Promise<DecodedAudio> {
  const context = new OfflineAudioContext(1, 1, 48000)
  const buffer = await context.decodeAudioData(arrayBuffer)
  const channels = buffer.numberOfChannels
  const channelData = new Float32Array(buffer.length)
  for (let channel = 0; channel < channels; channel++) {
    const data = buffer.getChannelData(channel)
    for (let i = 0; i < data.length; i++) channelData[i]! += data[i]! / channels
  }
  return { channelData, sampleRate: buffer.sampleRate }
}

export function useVoiceDictation(options: {
  getContext: () => string
  insertText: (text: string) => void
  focusEditor?: () => void
}) {
  const sdk = useSDK()
  const globalSync = useGlobalSync()
  const dialog = useDialog()
  const { i18n } = useLocale()
  const [phase, setPhase] = createSignal<VoiceDictationPhase>("idle")
  let previousPhase: VoiceDictationPhase = "idle"

  const reportFailure = (title: MessageDescriptor, description: MessageDescriptor, error: unknown) => {
    showToast({
      type: "error",
      title: i18n._(title),
      description: requestErrorMessage(error, i18n._(description)),
    })
  }

  const report = (event: VoiceDictationReport) => {
    switch (event.kind) {
      case "unsupported":
        showToast({ type: "warning", description: i18n._(PI.voiceUnsupported) })
        break
      case "permission-denied":
        showToast({
          type: "warning",
          title: i18n._(PI.voicePermissionTitle),
          description: i18n._(PI.voicePermissionDescription),
        })
        break
      case "microphone-error":
        reportFailure(PI.voiceMicErrorTitle, PI.voiceMicErrorDescription, event.error)
        break
      case "transcription-failed":
        if (isMicSilenceReason(event.error)) {
          showToast({
            type: "warning",
            title: i18n._(PI.voiceMicSilenceTitle),
            description: i18n._(PI.voiceMicSilenceDescription),
          })
          break
        }
        if (isNoSpeechReason(event.error)) {
          showToast({
            type: "warning",
            title: i18n._(PI.voiceNoSpeechTitle),
            description: i18n._(PI.voiceNoSpeechDescription),
          })
          break
        }
        reportFailure(PI.voiceFailedTitle, PI.voiceFailedDescription, event.error)
        break
    }
  }

  // MediaRecorder glue lives here: the engine only sees structural interfaces,
  // so its state machine stays testable without a browser. getUserMedia /
  // MediaRecorder existence is re-checked inside the engine at start time.
  const mediaRecorder = {
    createRecorder(
      stream: VoiceDictationStream,
      mimeType: string | undefined,
      handlers: VoiceDictationRecorderHandlers,
    ) {
      const mediaStream = stream as MediaStream
      const recorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined)
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) handlers.onData(event.data)
      })
      recorder.addEventListener("stop", () => handlers.onStop())
      recorder.addEventListener("error", () => handlers.onError())
      return {
        mimeType: recorder.mimeType,
        start: () => recorder.start(),
        stop: () => recorder.stop(),
      }
    },
  }

  const deps: VoiceDictationDependencies = {
    isConfigured: () => isSttConfigured(globalSync.data.config),
    openSettings: () => dialog.show(() => <SettingsDialog initialTab="voice" />),
    getContext: options.getContext,
    insertText: options.insertText,
    hasGetUserMedia: () => typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia),
    requestMicrophone: () => navigator.mediaDevices!.getUserMedia({ audio: true }),
    hasMediaRecorder: () => typeof MediaRecorder !== "undefined",
    isTypeSupported: (mimeType) => MediaRecorder.isTypeSupported(mimeType),
    createRecorder: mediaRecorder.createRecorder,
    nowMs: () => Date.now(),
    transcribe: async (input) => {
      // Real microphone clips are often far below full scale (or digitally
      // silent when the OS routes no audio to the browser); STT voice-activity
      // detection treats such clips as silence. Decode, peak-normalize, and
      // re-encode as PCM16 WAV before uploading; truly silent clips are
      // reported locally instead of wasting a provider call.
      const prepared = await normalizeDictationBlob(input.file, decodeDictationAudio)
      if (prepared.kind === "silence") {
        throw Object.assign(new Error("Microphone captured no sound"), { reason: "voice_mic_silence" })
      }
      const result = await sdk.client.voice.transcribe(
        { file: prepared.file, ...(input.context ? { context: input.context } : {}) },
        { throwOnError: true },
      )
      return { text: result.data?.text ?? "" }
    },
    report,
    onPhaseChange: (next) => {
      // A recording session always begins from a click on this button, so the
      // button keeps focus until the flow ends. Return focus to the composer
      // editor when the dictation finishes; otherwise Enter would re-trigger
      // the microphone instead of submitting the prompt.
      if ((previousPhase === "recording" || previousPhase === "transcribing") && next === "idle") {
        options.focusEditor?.()
      }
      previousPhase = next
      setPhase(next)
    },
  }

  const engine = createVoiceDictationEngine(deps)

  // While recording, Escape stops the dictation in the capture phase so the
  // composer's own Escape handling (abort running session / close popovers)
  // never fires for the key that ended the recording.
  createEffect(() => {
    if (phase() !== "recording") return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      engine.stop()
    }
    window.addEventListener("keydown", onKeyDown, true)
    onCleanup(() => window.removeEventListener("keydown", onKeyDown, true))
  })

  onCleanup(() => engine.dispose())

  return {
    phase,
    isConfigured: () => isSttConfigured(globalSync.data.config),
    toggle: () => {
      if (phase() === "idle") engine.start()
      else if (phase() === "recording") engine.stop()
    },
  }
}

export function VoiceDictationButton(props: {
  getContext: () => string
  insertText: (text: string) => void
  focusEditor?: () => void
}) {
  const dictation = useVoiceDictation(props)
  const { i18n } = useLocale()

  const ariaLabel = () => {
    if (dictation.phase() === "recording") return i18n._(PI.voiceStop)
    if (dictation.phase() === "transcribing") return i18n._(PI.voiceTranscribing)
    return i18n._(PI.voiceStart)
  }

  return (
    <Tooltip
      placement="top"
      value={
        dictation.phase() === "idle" && !dictation.isConfigured() ? (
          <div class="flex min-w-44 max-w-64 flex-col gap-1">
            <div class="text-12-medium text-text-strong">{i18n._(PI.voiceNotConfigured)}</div>
            <div class="text-11-regular text-text-weak">{i18n._(PI.voiceOpenSettings)}</div>
          </div>
        ) : (
          ariaLabel()
        )
      }
    >
      <button
        type="button"
        aria-label={ariaLabel()}
        class="prompt-input-toolbar-icon-button flex items-center justify-center"
        classList={{ "opacity-55": dictation.phase() === "idle" && !dictation.isConfigured() }}
        onClick={() => dictation.toggle()}
      >
        <Switch>
          <Match when={dictation.phase() === "recording"}>
            <span class="flex size-4 items-center justify-center animate-pulse">
              <Icon name={getSemanticIcon("action.stop")} size="small" class="text-icon-critical-base" />
            </span>
          </Match>
          <Match when={dictation.phase() === "transcribing"}>
            <Spinner class="size-4 text-icon-base" />
          </Match>
          <Match when={true}>
            <Icon
              name={getSemanticIcon("prompt.voice")}
              size="small"
              class={dictation.isConfigured() ? "text-icon-base" : "text-icon-weak-base"}
            />
          </Match>
        </Switch>
      </button>
    </Tooltip>
  )
}
