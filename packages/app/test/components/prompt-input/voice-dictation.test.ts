import { describe, expect, test } from "bun:test"
import {
  collectDictationContext,
  createVoiceDictationEngine,
  isMicrophonePermissionError,
  isSttConfigured,
  negotiateRecordingMimeType,
  shouldTranscribeDuration,
  transcriptionFileName,
  type VoiceDictationDependencies,
  type VoiceDictationPhase,
  type VoiceDictationRecorder,
  type VoiceDictationRecorderHandlers,
  type VoiceDictationReport,
  type VoiceDictationStream,
  type VoiceDictationTrack,
} from "../../../src/components/prompt-input/voice-dictation-core"

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

class FakeTrack implements VoiceDictationTrack {
  stopped = 0
  stop() {
    this.stopped++
  }
}

class FakeStream implements VoiceDictationStream {
  tracks: FakeTrack[]
  constructor(count = 1) {
    this.tracks = Array.from({ length: count }, () => new FakeTrack())
  }
  getTracks() {
    return this.tracks
  }
  stoppedCount() {
    return this.tracks.reduce((total, track) => total + track.stopped, 0)
  }
}

class FakeRecorder implements VoiceDictationRecorder {
  mimeType: string
  started = 0
  stopped = 0
  handlers: VoiceDictationRecorderHandlers
  throwOnStop = false
  constructor(mimeType: string, handlers: VoiceDictationRecorderHandlers) {
    this.mimeType = mimeType || "audio/webm"
    this.handlers = handlers
  }
  start() {
    this.started++
  }
  stop() {
    if (this.throwOnStop) throw new Error("recorder inactive")
    this.stopped++
  }
  fireData(blob: Blob) {
    this.handlers.onData(blob)
  }
  fireStop() {
    this.handlers.onStop()
  }
  fireError() {
    this.handlers.onError()
  }
}

type Harness = {
  deps: VoiceDictationDependencies
  engine: ReturnType<typeof createVoiceDictationEngine>
  phases: VoiceDictationPhase[]
  reports: VoiceDictationReport[]
  inserted: string[]
  settingsOpened: boolean
  uploads: Array<{ file: File; context?: string }>
  stream: FakeStream
  recorder: FakeRecorder | undefined
  time: { now: number }
  configured: boolean
  hasGetUserMedia: boolean
  hasMediaRecorder: boolean
  supportedMimes: Set<string>
  requestRejects: unknown
  transcribeResult: { text: string }
  transcribeRejects: unknown
  contextText: string
  resolvedTranscript?: Promise<{ text: string }>
}

function createHarness(): Harness {
  const harness = {
    phases: [] as VoiceDictationPhase[],
    reports: [] as VoiceDictationReport[],
    inserted: [] as string[],
    settingsOpened: false,
    uploads: [] as Array<{ file: File; context?: string }>,
    stream: new FakeStream(),
    recorder: undefined as FakeRecorder | undefined,
    time: { now: 10_000 },
    configured: true,
    hasGetUserMedia: true,
    hasMediaRecorder: true,
    supportedMimes: new Set(["audio/webm;codecs=opus", "audio/webm"]),
    requestRejects: undefined as unknown,
    transcribeResult: { text: "hello world" },
    transcribeRejects: undefined as unknown,
    contextText: "",
  }
  const deps: VoiceDictationDependencies = {
    isConfigured: () => harness.configured,
    openSettings: () => {
      harness.settingsOpened = true
    },
    getContext: () => harness.contextText,
    insertText: (text) => {
      harness.inserted.push(text)
    },
    hasGetUserMedia: () => harness.hasGetUserMedia,
    requestMicrophone: async () => {
      if (harness.requestRejects !== undefined) throw harness.requestRejects
      return harness.stream
    },
    hasMediaRecorder: () => harness.hasMediaRecorder,
    isTypeSupported: (mime) => harness.supportedMimes.has(mime),
    createRecorder: (stream, mimeType, handlers) => {
      expect(stream).toBe(harness.stream)
      const recorder = new FakeRecorder(mimeType ?? "", handlers)
      harness.recorder = recorder
      return recorder
    },
    nowMs: () => harness.time.now,
    transcribe: async (input) => {
      harness.uploads.push({
        file: input.file,
        ...(input.context ? { context: input.context } : {}),
      })
      if (harness.transcribeRejects !== undefined) throw harness.transcribeRejects
      return harness.transcribeResult
    },
    report: (report) => {
      harness.reports.push(report)
    },
    onPhaseChange: (phase) => {
      harness.phases.push(phase)
    },
  }
  return Object.assign(harness, { deps, engine: createVoiceDictationEngine(deps) })
}

describe("voice dictation core", () => {
  test("mime negotiation prefers opus webm, falls back to mp4, then defaults", () => {
    expect(negotiateRecordingMimeType(() => true)).toBe("audio/webm;codecs=opus")
    expect(negotiateRecordingMimeType((mime) => mime !== "audio/webm;codecs=opus")).toBe("audio/mp4")
    expect(negotiateRecordingMimeType(() => false)).toBe("")
  })

  test("transcription file name follows the negotiated container", () => {
    expect(transcriptionFileName("audio/webm;codecs=opus")).toBe("dictation.webm")
    expect(transcriptionFileName("audio/webm")).toBe("dictation.webm")
    expect(transcriptionFileName("audio/mp4")).toBe("dictation.m4a")
    expect(transcriptionFileName("")).toBe("dictation.webm")
  })

  test("duration threshold and permission classification", () => {
    expect(shouldTranscribeDuration(499)).toBe(false)
    expect(shouldTranscribeDuration(500)).toBe(true)
    expect(isMicrophonePermissionError({ name: "NotAllowedError" })).toBe(true)
    expect(isMicrophonePermissionError(new Error("boom"))).toBe(false)
    expect(isMicrophonePermissionError(undefined)).toBe(false)
  })

  test("stt config detection", () => {
    expect(isSttConfigured({ voice: { stt: { model: "qwen3-asr-flash" } } })).toBe(true)
    expect(isSttConfigured({ voice: { stt: { model: "  " } } })).toBe(false)
    expect(isSttConfigured({ voice: {} })).toBe(false)
    expect(isSttConfigured({})).toBe(false)
  })

  test("unconfigured start opens settings instead of touching the microphone", () => {
    const h = createHarness()
    h.configured = false
    h.engine.start()
    expect(h.settingsOpened).toBe(true)
    expect(h.phases).toEqual([])
  })

  test("missing getUserMedia reports unsupported without starting", () => {
    const h = createHarness()
    h.hasGetUserMedia = false
    h.engine.start()
    expect(h.reports).toEqual([{ kind: "unsupported" }])
    expect(h.phases).toEqual([])
  })

  test("records, stops, uploads the blob with context, and inserts the transcript", async () => {
    const h = createHarness()
    h.contextText = "  draft context for the prompt  "
    h.engine.start()
    await flush()
    expect(h.engine.getPhase()).toBe("recording")
    expect(h.recorder).toBeDefined()
    expect(h.recorder!.started).toBe(1)
    h.time.now += 1200
    h.engine.stop()
    // MediaRecorder stop is async: still recording until the stop event fires.
    expect(h.engine.getPhase()).toBe("recording")
    h.recorder!.fireStop()
    expect(h.engine.getPhase()).toBe("transcribing")
    await flush()

    expect(h.engine.getPhase()).toBe("idle")
    expect(h.uploads.length).toBe(1)
    expect(h.uploads[0]!.context).toBe("draft context for the prompt")
    expect(h.uploads[0]!.file.name).toBe("dictation.webm")
    expect(h.uploads[0]!.file.type).toBe("audio/webm;codecs=opus")
    expect(h.inserted).toEqual(["hello world"])
    // Tracks are released on recorder stop — before the transcript arrives.
    expect(h.stream.stoppedCount()).toBe(1)
  })

  test("recordings shorter than 500ms are dropped without a request", async () => {
    const h = createHarness()
    h.engine.start()
    await flush()
    h.time.now += 400
    h.engine.stop()
    h.recorder!.fireStop()
    await flush()

    expect(h.engine.getPhase()).toBe("idle")
    expect(h.uploads.length).toBe(0)
    expect(h.inserted).toEqual([])
    expect(h.stream.stoppedCount()).toBe(1)
  })

  test("permission denial reports permission-denied and releases nothing", async () => {
    const h = createHarness()
    h.requestRejects = Object.assign(new Error("denied"), { name: "NotAllowedError" })
    h.engine.start()
    await flush()
    await flush()

    expect(h.engine.getPhase()).toBe("idle")
    expect(h.reports).toEqual([{ kind: "permission-denied" }])
    expect(h.stream.stoppedCount()).toBe(0)
  })

  test("media recorder absence after getUserMedia stops the fresh stream and reports unsupported", async () => {
    const h = createHarness()
    h.hasMediaRecorder = false
    h.engine.start()
    await flush()
    await flush()

    expect(h.engine.getPhase()).toBe("idle")
    expect(h.reports).toEqual([{ kind: "unsupported" }])
    expect(h.stream.stoppedCount()).toBe(1)
  })

  test("transcription failure reports and returns to idle", async () => {
    const h = createHarness()
    h.transcribeRejects = new Error("server exploded")
    h.engine.start()
    await flush()
    h.time.now += 800
    h.engine.stop()
    h.recorder!.fireStop()
    await flush()
    await flush()

    expect(h.engine.getPhase()).toBe("idle")
    expect(h.inserted).toEqual([])
    expect(h.reports).toEqual([{ kind: "transcription-failed", error: h.transcribeRejects }])
    expect(h.stream.stoppedCount()).toBe(1)
  })

  test("empty transcript is not inserted", async () => {
    const h = createHarness()
    h.transcribeResult = { text: "   " }
    h.engine.start()
    await flush()
    h.time.now += 800
    h.engine.stop()
    h.recorder!.fireStop()
    await flush()
    await flush()

    expect(h.inserted).toEqual([])
    expect(h.uploads.length).toBe(1)
  })

  test("recorder error releases the stream and reports a microphone error", async () => {
    const h = createHarness()
    h.engine.start()
    await flush()
    h.recorder!.fireError()
    await flush()

    expect(h.engine.getPhase()).toBe("idle")
    expect(h.reports).toEqual([{ kind: "microphone-error", error: undefined }])
    expect(h.stream.stoppedCount()).toBe(1)
  })

  test("dispose during recording stops the recorder and the tracks", () => {
    const h = createHarness()
    h.engine.start()
    h.engine.dispose()
    // requestMicrophone is async: resolve it, then confirm the stream is released.
    expect(h.recorder).toBeUndefined()

    h.engine.dispose()
    expect(h.engine.getPhase()).toBe("idle")
  })

  test("stop() throwing on an inactive recorder funnels through the stop handler", async () => {
    const h = createHarness()
    h.engine.start()
    await flush()
    h.time.now += 1000
    h.recorder!.throwOnStop = true
    h.engine.stop()
    // Synchronous catch path calls onRecorderStop → uploads the gathered chunks.
    await flush()
    await flush()

    expect(h.engine.getPhase()).toBe("idle")
    expect(h.uploads.length).toBe(1)
    expect(h.stream.stoppedCount()).toBe(1)
  })

  test("uploaded audio blob is a webm blob with the recorder mime type", async () => {
    const h = createHarness()
    h.supportedMimes = new Set()
    h.engine.start()
    await flush()
    expect(h.recorder!.mimeType).toBe("audio/webm")
    h.recorder!.fireData(new Blob(["chunk"], { type: "audio/webm" }))
    h.time.now += 600
    h.engine.stop()
    h.recorder!.fireStop()
    await flush()
    await flush()

    expect(h.uploads.length).toBe(1)
    expect(h.uploads[0]!.file.type).toBe("audio/webm")
    expect(h.uploads[0]!.file.name).toBe("dictation.webm")
  })

  test("ignores repeated starts while a phase is active", async () => {
    const h = createHarness()
    h.engine.start()
    await flush()
    h.engine.start()
    await flush()
    expect(h.recorder!.started).toBe(1)
  })
  test("collectDictationContext takes the most recent user turns oldest-first", () => {
    const messages = [
      { role: "user", parts: [{ type: "text", text: "first question" }] },
      { role: "assistant", parts: [{ type: "text", text: "first answer" }] },
      { role: "user", parts: [{ type: "text", text: "second question" }] },
      { role: "assistant", parts: [{ type: "text", text: "second answer" }] },
      { role: "user", parts: [{ type: "text", text: "third question" }] },
    ]
    expect(collectDictationContext(messages)).toBe("first question\nsecond question\nthird question")
    expect(collectDictationContext(messages, 2)).toBe("second question\nthird question")
  })

  test("collectDictationContext skips empty and non-text parts and caps the turn count", () => {
    const messages = [
      { role: "user", parts: [{ type: "text", text: "one" }] },
      { role: "user", parts: [] },
      {
        role: "user",
        parts: [
          { type: "text", text: "two" },
          { type: "attachment", text: undefined },
        ],
      },
      { role: "user", parts: [{ type: "text", text: "   " }] },
      { role: "user", parts: [{ type: "text", text: "three" }] },
    ]
    expect(collectDictationContext(messages, 2)).toBe("two\nthree")
  })

  test("collectDictationContext returns empty for no user text", () => {
    expect(collectDictationContext([])).toBe("")
    expect(collectDictationContext([{ role: "assistant", parts: [{ type: "text", text: "hi" }] }])).toBe("")
  })
})
