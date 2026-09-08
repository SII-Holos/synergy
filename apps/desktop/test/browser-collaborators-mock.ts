import { mock } from "bun:test"

// Shared Browser collaborator mocks. page-pool, webrtc-host, and the broker
// suite all stub BrowserHostDiagnostics, BrowserWebContentsControl, and
// BrowserWebRTCHost, and bun's mock.module registry is per-worker with
// first-registration-wins, so every file that imports any collaborator must
// register these same factories and drive the shared mutable state below.
// Files that test a REAL collaborator import it through a query suffix
// (e.g. "../src/browser-webcontents-control.js?real") to dodge these mocks.
export const sharedDiagnosticsState = {
  failStart: false,
  failDispose: false,
  startCalls: 0,
  disposeCalls: 0,
  instances: [] as Array<{ options: unknown; startCalls: number; disposeCalls: number }>,
}

class SharedBrowserHostDiagnostics {
  readonly instance = { options: undefined as unknown, startCalls: 0, disposeCalls: 0 }

  constructor(options: unknown) {
    this.instance.options = options
    sharedDiagnosticsState.instances.push(this.instance)
  }

  async start() {
    if (sharedDiagnosticsState.failStart) throw new Error("diagnostics start failed")
    this.instance.startCalls++
    sharedDiagnosticsState.startCalls++
  }

  async dispose() {
    if (sharedDiagnosticsState.failDispose) throw new Error("diagnostics dispose failed")
    this.instance.disposeCalls++
    sharedDiagnosticsState.disposeCalls++
  }

  async respondToDialog() {}
  async respondToFileChooser() {}
  async cancelDownload() {}
  async stageFiles() {
    return { paths: [] as string[], cleanup: async () => undefined }
  }
}

export const sharedControlState = {
  commands: [] as unknown[],
  resizeHandlers: [] as Array<(width: number, height: number) => void>,
  nextError: null as Error | null,
  failDispose: false,
  instances: [] as Array<{
    options: unknown
    commands: unknown[]
    disposeCalls: number
    dispatchInputs: unknown[]
  }>,
}

class SharedBrowserWebContentsControl {
  readonly instance = {
    options: undefined as unknown,
    commands: [] as unknown[],
    disposeCalls: 0,
    dispatchInputs: [] as unknown[],
  }

  constructor(options: unknown) {
    this.instance.options = options
    sharedControlState.instances.push(this.instance)
    const candidate = options as { resize?: (width: number, height: number) => void }
    if (candidate.resize) sharedControlState.resizeHandlers.push(candidate.resize)
  }

  async execute(command: unknown) {
    this.instance.commands.push(command)
    sharedControlState.commands.push(command)
    if (sharedControlState.nextError) {
      const error = sharedControlState.nextError
      sharedControlState.nextError = null
      throw error
    }
    return { type: "void" }
  }

  dispatchInput(payload: unknown) {
    this.instance.dispatchInputs.push(payload)
    sharedControlState.commands.push({ dispatchInput: payload })
  }

  async dispose() {
    if (sharedControlState.failDispose) throw new Error("control dispose failed")
    this.instance.disposeCalls++
  }
}

export const sharedWebRtcHostState = {
  startDeferred: null as { resolve(): void; promise: Promise<void> } | null,
  releaseStart: null as { resolve(): void; promise: Promise<void> } | null,
  created: [] as SharedBrowserWebRTCHost[],
  appliedThemes: [] as unknown[],
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { resolve, promise }
}

class SharedBrowserWebRTCHost {
  renewedTickets: string[] = []
  options: { theme?: unknown }

  constructor(options: { theme?: unknown }) {
    this.options = options
    sharedWebRtcHostState.created.push(this)
  }

  async start() {
    sharedWebRtcHostState.startDeferred?.resolve()
    await sharedWebRtcHostState.releaseStart?.promise
  }

  setTheme(theme: unknown) {
    this.options.theme = theme
    sharedWebRtcHostState.appliedThemes.push(theme)
  }

  updateSignalingTicket(ticket: string) {
    this.renewedTickets.push(ticket)
  }

  state() {
    return { id: "page-test", url: "about:blank", title: "", isLoading: false, lastActiveAt: null }
  }

  async destroy() {}

  isAlive() {
    return true
  }
}

export function registerBrowserCollaboratorMocks(): void {
  mock.module("../src/browser-host-diagnostics.js", () => ({
    BrowserHostDiagnostics: SharedBrowserHostDiagnostics,
  }))
  mock.module("../src/browser-webcontents-control.js", () => ({
    BrowserWebContentsControl: SharedBrowserWebContentsControl,
  }))
  mock.module("../src/browser-webrtc-host.js", () => ({
    BrowserWebRTCHost: SharedBrowserWebRTCHost,
  }))
}

export function resetBrowserCollaboratorMocks(): void {
  sharedDiagnosticsState.failStart = false
  sharedDiagnosticsState.failDispose = false
  sharedDiagnosticsState.startCalls = 0
  sharedDiagnosticsState.disposeCalls = 0
  sharedDiagnosticsState.instances = []
  sharedControlState.commands = []
  sharedControlState.resizeHandlers = []
  sharedControlState.nextError = null
  sharedControlState.failDispose = false
  sharedControlState.instances = []
  sharedWebRtcHostState.startDeferred = null
  sharedWebRtcHostState.releaseStart = null
  sharedWebRtcHostState.created = []
  sharedWebRtcHostState.appliedThemes = []
}
