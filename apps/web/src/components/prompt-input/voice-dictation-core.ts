export type VoiceDictationPhase = "idle" | "recording" | "transcribing"

export const MIN_DICTATION_DURATION_MS = 500
export const MAX_DICTATION_CONTEXT_CHARS = 500

/** A minimal structural view of a session message for context collection. */
export interface DictationContextMessage {
  role: string
  parts?: Array<{ type: string; text?: string }>
}

/**
 * Collect the most recent user message texts for STT context conditioning.
 * Walks the session transcript newest-first (the store keeps newest-last),
 * takes up to maxMessages user turns, and returns them oldest-first joined
 * by newlines. Assistant turns and non-text parts are skipped.
 */
export function collectDictationContext(messages: readonly DictationContextMessage[], maxMessages = 3): string {
  const collected: string[] = []
  for (let i = messages.length - 1; i >= 0 && collected.length < maxMessages; i--) {
    const message = messages[i]
    if (message.role !== "user") continue
    const text = (message.parts ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("")
    if (text.trim()) collected.unshift(text)
  }
  return collected.join("\n")
}
const RECORDING_MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/mp4"]

/** Pick the first MediaRecorder mimeType the environment supports; "" means "let the browser choose". */
export function negotiateRecordingMimeType(isTypeSupported: (mimeType: string) => boolean): string {
  return RECORDING_MIME_CANDIDATES.find((candidate) => isTypeSupported(candidate)) ?? ""
}

/** Server-side voice route accepts container extensions; m4a avoids webm name mismatches for mp4 recordings. */
export function transcriptionFileName(mimeType: string): string {
  if (/mp4|m4a/i.test(mimeType)) return "dictation.m4a"
  return "dictation.webm"
}

export function shouldTranscribeDuration(durationMs: number): boolean {
  return durationMs >= MIN_DICTATION_DURATION_MS
}

export function isMicrophonePermissionError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "NotAllowedError"
}

/** Extract the structured `reason` field from a route error, if present. */
export function errorReason(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const data = (error as { data?: unknown }).data
  if (typeof data === "object" && data !== null) {
    const nested = (data as { reason?: unknown }).reason
    if (typeof nested === "string") return nested
  }
  const reason = (error as { reason?: unknown }).reason
  return typeof reason === "string" ? reason : undefined
}

/** True when the voice route reported that no speech was detected in the clip. */
export function isNoSpeechReason(error: unknown): boolean {
  return errorReason(error) === "voice_no_speech"
}

/** True when the client detected that the microphone captured no sound at all. */
export function isMicSilenceReason(error: unknown): boolean {
  return errorReason(error) === "voice_mic_silence"
}

export function isSttConfigured(config: { voice?: { stt?: { model?: string } } }): boolean {
  const model = config.voice?.stt?.model
  return typeof model === "string" && model.trim().length > 0
}

export interface VoiceDictationTrack {
  stop(): void
}

export interface VoiceDictationStream {
  getTracks(): VoiceDictationTrack[]
}

export interface VoiceDictationRecorderHandlers {
  onData(data: Blob): void
  onStop(): void
  onError(): void
}

export interface VoiceDictationRecorder {
  readonly mimeType: string
  start(): void
  stop(): void
}

export type VoiceDictationReport =
  | { kind: "unsupported" }
  | { kind: "permission-denied" }
  | { kind: "microphone-error"; error: unknown }
  | { kind: "transcription-failed"; error: unknown }

export interface VoiceDictationDependencies {
  isConfigured(): boolean
  openSettings(): void
  getContext(): string
  insertText(text: string): void
  hasGetUserMedia(): boolean
  requestMicrophone(): Promise<VoiceDictationStream>
  hasMediaRecorder(): boolean
  isTypeSupported(mimeType: string): boolean
  createRecorder(
    stream: VoiceDictationStream,
    mimeType: string | undefined,
    handlers: VoiceDictationRecorderHandlers,
  ): VoiceDictationRecorder
  nowMs(): number
  transcribe(input: { file: File; context?: string }): Promise<{ text: string }>
  report(report: VoiceDictationReport): void
  onPhaseChange(phase: VoiceDictationPhase): void
}

export interface VoiceDictationEngine {
  getPhase(): VoiceDictationPhase
  start(): void
  stop(): void
  dispose(): void
}

/**
 * Voice dictation state machine over injected browser/media primitives.
 * MediaRecorder stop is asynchronous, so every terminal path funnels through
 * the recorder stop handlers and the releaseStream helper — tracks are always
 * stopped exactly once, whether the recording is dropped as too short,
 * transcribed, or the recorder errors out.
 */
export function createVoiceDictationEngine(deps: VoiceDictationDependencies): VoiceDictationEngine {
  let phase: VoiceDictationPhase = "idle"
  let disposed = false
  let starting = false
  let stream: VoiceDictationStream | undefined
  let recorder: VoiceDictationRecorder | undefined
  let chunks: Blob[] = []
  let startedAtMs: number | undefined
  let dropping = false
  let finishing = false

  const setPhase = (next: VoiceDictationPhase) => {
    phase = next
    deps.onPhaseChange(next)
  }

  const releaseStream = () => {
    if (stream) {
      for (const track of stream.getTracks()) track.stop()
      stream = undefined
    }
  }

  const finishUpload = (mimeType: string) => {
    finishing = true
    const blob = new Blob(chunks, { type: mimeType || undefined })
    chunks = []
    void (async () => {
      const context = deps.getContext().trim().slice(0, MAX_DICTATION_CONTEXT_CHARS) || undefined
      try {
        const result = await deps.transcribe({
          file: new File([blob], transcriptionFileName(mimeType), { type: mimeType || undefined }),
          ...(context ? { context } : {}),
        })
        if (result.text.trim() && !disposed) deps.insertText(result.text)
      } catch (error) {
        if (!disposed) deps.report({ kind: "transcription-failed", error })
      } finally {
        finishing = false
        if (!disposed) setPhase("idle")
      }
    })()
  }

  const onRecorderStop = () => {
    if (disposed) return
    const active = recorder
    recorder = undefined
    if (!active) return
    releaseStream()
    if (dropping) {
      dropping = false
      setPhase("idle")
      return
    }
    setPhase("transcribing")
    finishUpload(active.mimeType)
  }

  const onRecorderError = () => {
    if (disposed) return
    recorder = undefined
    dropping = false
    releaseStream()
    setPhase("idle")
    deps.report({ kind: "microphone-error", error: undefined })
  }

  const stop = () => {
    if (disposed || phase !== "recording" || !recorder || startedAtMs === undefined) return
    const durationMs = deps.nowMs() - startedAtMs
    startedAtMs = undefined
    dropping = !shouldTranscribeDuration(durationMs)
    try {
      recorder.stop()
    } catch {
      // stop() throws when the recorder is already inactive — treat as dropped.
      onRecorderStop()
    }
  }

  const start = () => {
    if (disposed || starting || phase !== "idle") return
    if (!deps.isConfigured()) {
      deps.openSettings()
      return
    }
    if (!deps.hasGetUserMedia()) {
      deps.report({ kind: "unsupported" })
      return
    }
    starting = true
    void (async () => {
      try {
        const nextStream = await deps.requestMicrophone()
        if (disposed) {
          for (const track of nextStream.getTracks()) track.stop()
          return
        }
        if (!deps.hasMediaRecorder()) {
          for (const track of nextStream.getTracks()) track.stop()
          if (!disposed) deps.report({ kind: "unsupported" })
          return
        }
        stream = nextStream
        const mimeType = negotiateRecordingMimeType(deps.isTypeSupported)
        const nextRecorder = deps.createRecorder(nextStream, mimeType || undefined, {
          onData: (data) => chunks.push(data),
          onStop: onRecorderStop,
          onError: onRecorderError,
        })
        recorder = nextRecorder
        startedAtMs = deps.nowMs()
        nextRecorder.start()
        setPhase("recording")
      } catch (error) {
        if (isMicrophonePermissionError(error)) {
          if (!disposed) deps.report({ kind: "permission-denied" })
          return
        }
        recorder = undefined
        releaseStream()
        if (!disposed) deps.report({ kind: "microphone-error", error })
      } finally {
        starting = false
      }
    })()
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    if (recorder && !finishing) {
      try {
        recorder.stop()
      } catch {
        // ignore — recorder may already be inactive
      }
    }
    releaseStream()
    recorder = undefined
    chunks = []
    startedAtMs = undefined
    dropping = false
  }

  return {
    getPhase: () => phase,
    start,
    stop,
    dispose,
  }
}
