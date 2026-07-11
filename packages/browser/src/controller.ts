import { BrowserProtocolError } from "./error.js"
import { redactBrowserHeaders, redactBrowserText, redactBrowserURL } from "./redaction.js"
import { BrowserStagingLeasePool } from "./staging.js"
import {
  BrowserBackendCommandSchema,
  BrowserCheckpointSchema,
  type BrowserAction,
  type BrowserBackendCommand,
  type BrowserBackendResult,
  type BrowserCheckpoint,
  type BrowserEmulation,
  type BrowserLocator,
  type BrowserObstruction,
  type BrowserPage,
  type BrowserParsedBackendCommand,
  type BrowserPoint,
  type BrowserSnapshotElement,
  type BrowserTarget,
  type BrowserWaitCondition,
} from "./protocol.js"

export interface CdpTransport {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  on(event: string, listener: (params: unknown) => void): () => void
}

export function withCdpCommandTimeout<T>(command: Promise<T>, method: string, timeoutMs = 10_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`CDP command ${method} timed out after ${timeoutMs / 1_000} seconds.`)),
      timeoutMs,
    )
    timer.unref?.()
    command.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export function cdpCommandTimeoutMs(method: string, params?: Record<string, unknown>): number {
  if (method === "Runtime.callFunctionOn" && typeof params?.timeout === "number") {
    return Math.min(122_000, Math.max(2_000, params.timeout + 2_000))
  }
  if (method === "Runtime.evaluate" && typeof params?.timeout === "number") {
    return Math.min(123_000, Math.max(10_000, params.timeout + 3_000))
  }
  if (method === "Page.captureScreenshot" || method === "Network.getResponseBody") return 30_000
  return 10_000
}

interface RemoteObject {
  objectId?: string
  value?: unknown
  description?: string
  subtype?: string
  unserializableValue?: string
}

interface RuntimeResult {
  result: RemoteObject
  exceptionDetails?: { text?: string; exception?: { description?: string } }
}

interface CdpAxNode {
  nodeId?: string
  parentId?: string
  backendDOMNodeId?: number
  frameId?: string
  role?: { value?: unknown }
  name?: { value?: unknown }
  value?: { value?: unknown }
  description?: { value?: unknown }
}

interface CdpNodeResult {
  node?: { backendNodeId?: number; frameId?: string }
}

interface CdpEventMap {
  "Page.frameNavigated": { frame?: { parentId?: string; id?: string } }
  "Runtime.executionContextsCleared": unknown
  "Runtime.executionContextCreated": {
    context?: { id?: number; auxData?: { frameId?: string; isDefault?: boolean } }
  }
  "Page.frameStartedLoading": { frameId?: string }
  "Page.frameStoppedLoading": unknown
  "Page.lifecycleEvent": { frameId?: string; name?: string }
  "Page.javascriptDialogOpening": { type?: string; message?: string; defaultPrompt?: string; url?: string }
  "Browser.downloadWillBegin": { guid?: string; url?: string; suggestedFilename?: string }
  "Runtime.consoleAPICalled": {
    args?: RemoteObject[]
    type?: string
    timestamp?: number
    stackTrace?: unknown
  }
  "Log.entryAdded": {
    entry?: { level?: string; text?: string; timestamp?: number; url?: string; stackTrace?: unknown }
  }
  "Network.requestWillBeSent": {
    requestId?: string
    type?: string
    timestamp?: number
    request?: { url?: string; method?: string; headers?: unknown; postData?: string }
  }
  "Network.responseReceived": {
    requestId?: string
    type?: string
    response?: {
      status?: number
      statusText?: string
      headers?: unknown
      mimeType?: string
      protocol?: string
      remoteIPAddress?: string
      fromDiskCache?: boolean
      timing?: unknown
    }
  }
  "Network.loadingFinished": { requestId?: string }
  "Network.loadingFailed": { requestId?: string; errorText?: string }
  "Tracing.dataCollected": { value?: unknown[] }
  "Tracing.tracingComplete": unknown
}

interface CdpEventListener {
  type?: string
  useCapture?: boolean
  passive?: boolean
  once?: boolean
  scriptId?: string
  lineNumber?: number
  columnNumber?: number
}

interface RefEntry {
  snapshotId: string
  ref: string
  generation: number
  backendNodeId: number
  frameId?: string
}

interface ConsoleEntry {
  id: string
  level: string
  text: string
  timestamp: number
  url?: string
  stack?: unknown
}

interface NetworkEntry {
  id: string
  url: string
  method: string
  resourceType?: string
  status?: number
  requestHeaders?: Record<string, unknown>
  requestPostData?: string
  responseHeaders?: Record<string, unknown>
  statusText?: string
  mimeType?: string
  protocol?: string
  remoteIPAddress?: string
  fromDiskCache?: boolean
  timing?: Record<string, unknown>
  failed?: string
  timestamp: number
}

interface LocatorSummary {
  count: number
  candidates: BrowserObstruction[]
}

interface ElementSample {
  visible: boolean
  enabled: boolean
  editable: boolean
  receivesEvents: boolean
  box: { x: number; y: number; width: number; height: number } | null
  obstruction?: BrowserObstruction
}

interface ElementState extends ElementSample {
  stable: boolean
}

const DEFAULT_ACTION_TIMEOUT_MS = 5_000
const POLL_MS = 100
const ACTION_STABILITY_POLL_MS = 50
const MAX_TRACE_EVENTS = 20_000
const MAX_TRACE_BYTES = 50 * 1024 * 1024
const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024
const MAX_REF_ENTRIES = 25_000
const MAX_SNAPSHOT_TEXT_CHARS = 2_000_000
const LONG_LIVED_NETWORK_TYPES = new Set(["WebSocket", "EventSource"])

function boxesAreStable(previous: ElementState["box"], current: ElementState["box"]): boolean {
  if (!previous || !current) return previous === current
  return (
    Math.abs(previous.x - current.x) < 0.5 &&
    Math.abs(previous.y - current.y) < 0.5 &&
    Math.abs(previous.width - current.width) < 0.5 &&
    Math.abs(previous.height - current.height) < 0.5
  )
}

export interface CdpPageControllerOptions {
  pageId: string
  transport: CdpTransport
  now?: () => number
  platform?: string
  clipboard?: { readText(): Promise<string> | string; writeText(text: string): Promise<void> | void }
  stageFiles?: (
    files: Array<{ name: string; mimeType: string; dataBase64: string }>,
  ) => Promise<{ paths: string[]; cleanup?: () => Promise<void> | void }>
}

export class CdpPageController {
  private generation = 0
  private snapshotSequence = 0
  private refs = new Map<string, RefEntry>()
  private staging = new BrowserStagingLeasePool()
  private initialized: Promise<void> | null = null
  private disposers: Array<() => void> = []
  private frameContexts = new Map<string, number>()
  private objectFrameOffsets = new Map<string, { x: number; y: number }>()
  private isolatedContexts = new Map<string, number>()
  private mainFrameId: string | undefined
  private loading = false
  private lifecycle = new Set<string>()
  private inflightRequests = new Set<string>()
  private consoleEntries: ConsoleEntry[] = []
  private consoleSequence = 0
  private networkEntries = new Map<string, NetworkEntry>()
  private latestDialog: Record<string, unknown> | null = null
  private latestDownload: Record<string, unknown> | null = null
  private traceChunks: unknown[] = []
  private traceBytes = 0
  private tracing = false
  private traceTruncated = false
  private traceComplete: (() => void) | null = null
  private now: () => number

  constructor(private options: CdpPageControllerOptions) {
    this.now = options.now ?? Date.now
    this.installEventListeners()
  }

  async execute(input: BrowserBackendCommand): Promise<BrowserBackendResult> {
    const command = BrowserBackendCommandSchema.parse(input)
    await this.ensureInitialized()

    switch (command.type) {
      case "navigate":
        return this.navigate(command.url)
      case "history":
        this.beginLoading()
        await this.options.transport.send("Page.navigateToHistoryEntry", {
          entryId: await this.historyEntry(command.direction),
        })
        return { type: "navigation", page: await this.pageState() }
      case "reload":
        this.beginLoading()
        await this.options.transport.send("Page.reload", { ignoreCache: command.ignoreCache ?? false })
        return { type: "void" }
      case "stop":
        await this.options.transport.send("Page.stopLoading")
        return { type: "void" }
      case "resume":
        return { type: "page", page: await this.pageState() }
      case "close":
        return { type: "void" }
      case "setViewport":
        await this.applyEmulation({ viewport: { width: command.width, height: command.height } })
        return { type: "page", page: await this.pageState() }
      case "dialog.respond":
        await this.options.transport.send("Page.handleJavaScriptDialog", {
          accept: command.accept,
          promptText: command.promptText,
        })
        this.latestDialog = null
        return { type: "void" }
      case "filechooser.select":
        throw new BrowserProtocolError({
          code: "browser_upload_staging_required",
          message:
            "File chooser content must be staged by the Browser upload service before it reaches the page backend.",
          retryable: false,
          pageId: this.options.pageId,
          suggestedAction: "Use browser_upload with a workspace path.",
        })
      case "snapshot":
        return this.snapshot(command.query, command.maxNodes)
      case "action":
        return this.action(command.action)
      case "wait":
        await this.wait(command.condition, command.timeoutMs)
        return { type: "wait", pageId: this.options.pageId, matched: true }
      case "evaluate":
        return {
          type: "evaluation",
          pageId: this.options.pageId,
          value: await this.evaluate(command.expression, command.mode === "readonly", command.timeoutMs),
        }
      case "screenshot":
        return this.screenshot(command)
      case "read":
        return { type: "data", pageId: this.options.pageId, data: await this.read(command) }
      case "inspect":
        return {
          type: "data",
          pageId: this.options.pageId,
          data: await this.inspect(command.target, command.computedStyles),
        }
      case "console":
        return { type: "data", pageId: this.options.pageId, data: this.console(command) }
      case "network":
        return { type: "data", pageId: this.options.pageId, data: await this.network(command) }
      case "performance":
        return { type: "data", pageId: this.options.pageId, data: await this.performance(command.action) }
      case "audit":
        return { type: "data", pageId: this.options.pageId, data: await this.audit(command.categories) }
      case "emulate":
        await this.applyEmulation(command.emulation)
        return { type: "page", page: await this.pageState() }
      case "dialog":
        return {
          type: "data",
          pageId: this.options.pageId,
          data: await this.dialog(command.action, command.promptText),
        }
      case "clipboard":
        return { type: "data", pageId: this.options.pageId, data: await this.clipboard(command.action, command.text) }
      case "upload":
        return { type: "data", pageId: this.options.pageId, data: await this.upload(command.target, command.files) }
      case "checkpoint": {
        if (command.action === "capture") {
          return { type: "data", pageId: this.options.pageId, data: await this.captureCheckpoint() }
        }
        if (!command.checkpoint) {
          throw new BrowserProtocolError({
            code: "browser_invalid_command",
            message: "checkpoint is required for restore.",
            retryable: false,
            pageId: this.options.pageId,
          })
        }
        return { type: "data", pageId: this.options.pageId, data: await this.restoreCheckpoint(command.checkpoint) }
      }
      case "download.cancel":
        await this.options.transport.send("Browser.cancelDownload", { guid: command.id })
        return { type: "void" }
    }
  }

  private async dialog(action: "status" | "accept" | "dismiss", promptText?: string) {
    if (action === "status") return { open: this.latestDialog !== null, dialog: this.latestDialog }
    if (!this.latestDialog) {
      throw new BrowserProtocolError({
        code: "browser_dialog_missing",
        message: "No JavaScript dialog is open.",
        retryable: true,
        pageId: this.options.pageId,
      })
    }
    await this.options.transport.send("Page.handleJavaScriptDialog", {
      accept: action === "accept",
      ...(action === "accept" && promptText !== undefined ? { promptText } : {}),
    })
    const dialog = this.latestDialog
    this.latestDialog = null
    return { open: false, handled: action, dialog }
  }

  private async clipboard(action: "read" | "write" | "clear", text?: string) {
    if (action === "write" && text !== undefined && new TextEncoder().encode(text).byteLength > 1024 * 1024) {
      throw new BrowserProtocolError({
        code: "browser_clipboard_too_large",
        message: "Clipboard content exceeds the 1 MB Browser limit.",
        retryable: false,
        pageId: this.options.pageId,
      })
    }
    if (!this.options.clipboard) {
      throw new BrowserProtocolError({
        code: "browser_clipboard_unavailable",
        message: "The active Browser backend has no approved clipboard adapter.",
        retryable: false,
        pageId: this.options.pageId,
      })
    }
    if (action === "read") {
      const value = await this.options.clipboard.readText()
      if (new TextEncoder().encode(value).byteLength > 1024 * 1024) {
        throw new BrowserProtocolError({
          code: "browser_clipboard_too_large",
          message: "Clipboard content exceeds the 1 MB Browser limit.",
          retryable: false,
          pageId: this.options.pageId,
        })
      }
      return { text: value }
    }
    const value = action === "clear" ? "" : text
    if (value === undefined) {
      throw new BrowserProtocolError({
        code: "browser_clipboard_text_required",
        message: "Clipboard write requires text.",
        retryable: false,
        pageId: this.options.pageId,
      })
    }
    await this.options.clipboard.writeText(value)
    return { written: true, byteLength: new TextEncoder().encode(value).byteLength }
  }

  private async upload(target: BrowserLocator, files: Array<{ name: string; mimeType: string; dataBase64: string }>) {
    if (!this.options.stageFiles) {
      throw new BrowserProtocolError({
        code: "browser_upload_unavailable",
        message: "The active browser backend cannot stage upload files.",
        retryable: false,
        pageId: this.options.pageId,
      })
    }
    const objectId = await this.resolveLocatorObject(target)
    const described = await this.options.transport.send<CdpNodeResult>("DOM.describeNode", { objectId, depth: 0 })
    const backendNodeId = described?.node?.backendNodeId
    if (!backendNodeId) this.throwMissing(target)
    const staged = await this.options.stageFiles(files)
    try {
      await this.options.transport.send("DOM.setFileInputFiles", { backendNodeId, files: staged.paths })
      this.staging.retain(staged.cleanup)
      return { uploaded: files.map((file) => ({ name: file.name, mimeType: file.mimeType })) }
    } catch (error) {
      await staged.cleanup?.()
      throw error
    }
  }

  async resolveRef(snapshotId: string, ref: string): Promise<RefEntry> {
    const entry = this.refs.get(`${snapshotId}:${ref}`)
    if (!entry || entry.generation !== this.generation) this.throwStaleRef(snapshotId, ref)
    return entry
  }

  private throwStaleRef(snapshotId: string, ref: string): never {
    throw new BrowserProtocolError({
      code: "browser_stale_ref",
      message: `Element ref ${ref} no longer belongs to the current document.`,
      retryable: true,
      pageId: this.options.pageId,
      snapshotId,
      suggestedAction: "Take a fresh browser_snapshot and use a ref from that snapshot.",
    })
  }

  async dispose(): Promise<void> {
    const failures: unknown[] = []
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose()
      } catch (error) {
        failures.push(error)
      }
    }
    this.refs.clear()
    this.frameContexts.clear()
    this.isolatedContexts.clear()
    this.objectFrameOffsets.clear()
    this.lifecycle.clear()
    this.inflightRequests.clear()
    this.consoleEntries = []
    this.networkEntries.clear()
    this.latestDialog = null
    this.latestDownload = null
    this.traceChunks = []
    this.traceBytes = 0
    this.traceComplete = null
    try {
      await this.staging.dispose()
    } catch (error) {
      failures.push(error)
    }
    if (failures.length) throw new AggregateError(failures, "Browser CDP controller did not dispose cleanly.")
  }

  private installEventListeners() {
    const on = <Event extends keyof CdpEventMap>(event: Event, listener: (params: CdpEventMap[Event]) => void) => {
      this.disposers.push(this.options.transport.on(event, (params) => listener(params as CdpEventMap[Event])))
    }

    on("Page.frameNavigated", (params) => {
      if (!params?.frame?.parentId) this.mainFrameId = params?.frame?.id
      this.invalidateDocument()
    })
    on("Runtime.executionContextsCleared", () => {
      this.frameContexts.clear()
      this.isolatedContexts.clear()
      this.invalidateDocument()
    })
    on("Runtime.executionContextCreated", (params) => {
      const context = params?.context
      const frameId = context?.auxData?.frameId
      if (frameId && context?.auxData?.isDefault && typeof context.id === "number")
        this.frameContexts.set(frameId, context.id)
    })
    on("Page.frameStartedLoading", (params) => {
      this.loading = true
      if (!params?.frameId || params.frameId === this.mainFrameId) this.lifecycle.clear()
    })
    on("Page.frameStoppedLoading", () => {
      this.loading = false
    })
    on("Page.lifecycleEvent", (params) => {
      if (!params?.frameId || params.frameId === this.mainFrameId) this.lifecycle.add(String(params?.name ?? ""))
    })
    on("Page.javascriptDialogOpening", (params) => {
      this.latestDialog = {
        type: String(params?.type ?? "").slice(0, 1_000),
        message: String(params?.message ?? "").slice(0, 100_000),
        defaultPrompt: String(params?.defaultPrompt ?? "").slice(0, 100_000),
        url: redactBrowserURL(String(params?.url ?? "")).slice(0, 20_000),
      }
    })
    on("Browser.downloadWillBegin", (params) => {
      this.latestDownload = {
        guid: String(params?.guid ?? "").slice(0, 20_000),
        url: redactBrowserURL(String(params?.url ?? "")).slice(0, 20_000),
        suggestedFilename: String(params?.suggestedFilename ?? "").slice(0, 1_024),
      }
    })
    on("Runtime.consoleAPICalled", (params) => {
      const text = (Array.isArray(params?.args) ? params.args : [])
        .slice(0, 100)
        .map((arg: RemoteObject) => this.remoteObjectText(arg).slice(0, 100_000))
        .join(" ")
      this.pushConsole({
        id: `console-${++this.consoleSequence}`,
        level: String(params?.type ?? "log"),
        text,
        timestamp: Number(params?.timestamp ?? this.now()),
        stack: redactConsoleStack(params?.stackTrace),
      })
    })
    on("Log.entryAdded", (params) => {
      const entry = params?.entry ?? {}
      this.pushConsole({
        id: `console-${++this.consoleSequence}`,
        level: String(entry.level ?? "log"),
        text: String(entry.text ?? ""),
        timestamp: Number(entry.timestamp ?? this.now()),
        url: typeof entry.url === "string" ? entry.url.slice(0, 20_000) : undefined,
        stack: redactConsoleStack(entry.stackTrace),
      })
    })
    on("Network.requestWillBeSent", (params) => {
      const requestId = String(params?.requestId ?? "")
      if (!requestId) return
      if (!LONG_LIVED_NETWORK_TYPES.has(String(params?.type ?? ""))) {
        this.inflightRequests.add(requestId)
      }
      this.networkEntries.set(requestId, {
        id: requestId,
        url: String(params?.request?.url ?? "").slice(0, 20_000),
        method: String(params?.request?.method ?? "GET").slice(0, 1_000),
        resourceType: params?.type === undefined ? undefined : String(params.type).slice(0, 1_000),
        requestHeaders: boundedHeaders(params?.request?.headers),
        requestPostData:
          typeof params?.request?.postData === "string" ? params.request.postData.slice(0, 200_000) : undefined,
        timestamp: Number(params?.timestamp ?? this.now()),
      })
      while (this.networkEntries.size > 5_000) {
        const oldest = this.networkEntries.keys().next().value
        if (typeof oldest !== "string") break
        this.networkEntries.delete(oldest)
      }
    })
    on("Network.responseReceived", (params) => {
      const requestId = String(params?.requestId ?? "")
      const entry = this.networkEntries.get(requestId)
      if (!entry) return
      const status = Number(params?.response?.status)
      entry.status = Number.isFinite(status) ? status : undefined
      entry.statusText = String(params?.response?.statusText ?? "").slice(0, 20_000)
      entry.resourceType = params?.type === undefined ? entry.resourceType : String(params.type).slice(0, 1_000)
      entry.responseHeaders = boundedHeaders(params?.response?.headers)
      entry.mimeType = String(params?.response?.mimeType ?? "").slice(0, 256)
      entry.protocol = String(params?.response?.protocol ?? "").slice(0, 1_000)
      entry.remoteIPAddress = String(params?.response?.remoteIPAddress ?? "").slice(0, 1_000)
      entry.fromDiskCache = Boolean(params?.response?.fromDiskCache)
      entry.timing = boundedRecord(params?.response?.timing)
    })
    on("Network.loadingFinished", (params) => {
      this.inflightRequests.delete(String(params?.requestId ?? ""))
    })
    on("Network.loadingFailed", (params) => {
      const requestId = String(params?.requestId ?? "")
      this.inflightRequests.delete(requestId)
      const entry = this.networkEntries.get(requestId)
      if (entry) entry.failed = String(params?.errorText ?? "Request failed").slice(0, 100_000)
    })
    on("Tracing.dataCollected", (params) => {
      if (!this.tracing) return
      const values = Array.isArray(params?.value) ? params.value : []
      for (const value of values) {
        let bytes = MAX_TRACE_BYTES + 1
        try {
          bytes = Buffer.byteLength(JSON.stringify(value) ?? "", "utf8")
        } catch {}
        if (this.traceChunks.length >= MAX_TRACE_EVENTS || this.traceBytes + bytes > MAX_TRACE_BYTES) {
          this.traceTruncated = true
          continue
        }
        this.traceChunks.push(value)
        this.traceBytes += bytes
      }
    })
    on("Tracing.tracingComplete", () => {
      this.traceComplete?.()
      this.traceComplete = null
    })
  }

  private invalidateDocument() {
    this.generation++
    this.refs.clear()
    this.objectFrameOffsets.clear()
  }

  private async ensureInitialized() {
    this.initialized ??= (async () => {
      await Promise.all([
        this.options.transport.send("Page.enable"),
        this.options.transport.send("Runtime.enable"),
        this.options.transport.send("DOM.enable"),
        this.options.transport.send("Accessibility.enable"),
        this.options.transport.send("Network.enable", {
          maxTotalBufferSize: 50 * 1024 * 1024,
          maxResourceBufferSize: 10 * 1024 * 1024,
          maxPostDataSize: 200 * 1024,
        }),
        this.options.transport.send("Log.enable"),
        this.options.transport.send("Performance.enable"),
        this.options.transport.send("Page.setLifecycleEventsEnabled", { enabled: true }),
      ])
      const tree = await this.options.transport.send<{ frameTree?: { frame?: { id?: string } } }>("Page.getFrameTree")
      this.mainFrameId = tree?.frameTree?.frame?.id ?? this.mainFrameId
      await this.options.transport.send("Page.addScriptToEvaluateOnNewDocument", {
        source: webVitalsBootstrap,
      })
      await this.runtimeEvaluate(webVitalsBootstrap, { returnByValue: true }).catch(() => undefined)
    })()
    try {
      return await this.initialized
    } catch (error) {
      this.initialized = null
      throw error
    }
  }

  private async navigate(url: string): Promise<BrowserBackendResult> {
    this.beginLoading()
    const result = await this.options.transport.send<{ errorText?: string }>("Page.navigate", { url })
    if (result?.errorText) {
      this.loading = false
      throw new BrowserProtocolError({
        code: "browser_navigation_failed",
        message: String(result.errorText),
        retryable: true,
        pageId: this.options.pageId,
        url,
      })
    }
    return { type: "navigation", page: await this.pageState() }
  }

  private beginLoading(): void {
    this.loading = true
    this.lifecycle.clear()
  }

  private async historyEntry(direction: "back" | "forward"): Promise<number> {
    const history = await this.options.transport.send<{
      currentIndex?: number
      entries?: Array<{ id?: number }>
    }>("Page.getNavigationHistory")
    const currentIndex = Number(history?.currentIndex ?? 0)
    const targetIndex = direction === "back" ? currentIndex - 1 : currentIndex + 1
    const entry = history?.entries?.[targetIndex]
    if (!entry) {
      throw new BrowserProtocolError({
        code: "browser_history_unavailable",
        message: `No ${direction} history entry is available.`,
        retryable: false,
        pageId: this.options.pageId,
      })
    }
    return Number(entry.id)
  }

  private async pageState(): Promise<BrowserPage> {
    const value = await this.runtimeValue<{ url: string; title: string }>(
      `({ url: globalThis.location?.href ?? "about:blank", title: globalThis.document?.title ?? "" })`,
    )
    return {
      id: this.options.pageId,
      url: String(value?.url ?? "about:blank").slice(0, 20_000),
      title: String(value?.title ?? "").slice(0, 20_000),
      isLoading: this.loading,
      lastActiveAt: this.now(),
    }
  }

  private async snapshot(query: string | undefined, maxNodes: number): Promise<BrowserBackendResult> {
    const result = await this.options.transport.send<{ nodes?: CdpAxNode[] }>("Accessibility.getFullAXTree")
    const snapshotId = `snap-${this.generation}-${++this.snapshotSequence}`
    const normalizedQuery = query?.trim().toLocaleLowerCase()
    const nodes = Array.isArray(result?.nodes) ? result.nodes : []
    const included = new Set<string>()
    if (normalizedQuery) {
      const byId = new Map(nodes.map((node) => [String(node.nodeId ?? ""), node]))
      for (const node of nodes) {
        if (!this.axSearchText(node).includes(normalizedQuery)) continue
        let current: CdpAxNode | undefined = node
        const seen = new Set<string>()
        while (current) {
          const id = String(current?.nodeId ?? "")
          if (!id || seen.has(id)) break
          seen.add(id)
          included.add(id)
          current = current?.parentId ? byId.get(String(current.parentId)) : undefined
        }
      }
    }
    const selected = normalizedQuery ? nodes.filter((node) => included.has(String(node.nodeId ?? ""))) : nodes
    const eligible = selected.filter((node) => {
      const backendNodeId = Number(node?.backendDOMNodeId)
      return Number.isFinite(backendNodeId) && backendNodeId > 0
    })
    const elements: BrowserSnapshotElement[] = []
    let textChars = 0

    for (const node of eligible.slice(0, maxNodes)) {
      const backendNodeId = Number(node?.backendDOMNodeId)
      const role = String(node?.role?.value ?? "").slice(0, 1_000)
      const name = String(node?.name?.value ?? "").slice(0, 100_000)
      const value = node?.value?.value === undefined ? undefined : String(node.value.value).slice(0, 100_000)
      const description =
        node?.description?.value === undefined ? undefined : String(node.description.value).slice(0, 100_000)
      const nodeChars = role.length + name.length + (value?.length ?? 0) + (description?.length ?? 0)
      if (textChars + nodeChars > MAX_SNAPSHOT_TEXT_CHARS) break
      textChars += nodeChars
      const ref = `@${this.snapshotSequence}-${elements.length + 1}`
      while (this.refs.size >= MAX_REF_ENTRIES) {
        const oldest = this.refs.keys().next().value
        if (typeof oldest !== "string") break
        this.refs.delete(oldest)
      }
      this.refs.set(`${snapshotId}:${ref}`, {
        snapshotId,
        ref,
        generation: this.generation,
        backendNodeId,
        frameId: node?.frameId,
      })
      elements.push({
        ref,
        role,
        name,
        ...(value ? { value } : {}),
        ...(description ? { description } : {}),
        depth: this.axDepth(node, nodes),
      })
    }

    return {
      type: "snapshot",
      pageId: this.options.pageId,
      snapshotId,
      elements,
      truncated: eligible.length > elements.length,
    }
  }

  private axSearchText(node: CdpAxNode): string {
    return `${node?.role?.value ?? ""} ${node?.name?.value ?? ""} ${node?.value?.value ?? ""} ${node?.description?.value ?? ""}`.toLocaleLowerCase()
  }

  private axDepth(node: CdpAxNode, nodes: CdpAxNode[]): number {
    const byId = new Map(nodes.map((item) => [item?.nodeId, item]))
    let depth = 0
    let current: CdpAxNode | undefined = node
    const seen = new Set<string>()
    while (current?.parentId && !seen.has(current.parentId) && depth < 100) {
      seen.add(current.parentId)
      current = byId.get(current.parentId)
      depth++
    }
    return depth
  }

  private async evaluate(expression: string, readonly: boolean, timeout: number | undefined): Promise<unknown> {
    const contextId = readonly ? await this.isolatedContext() : undefined
    if (readonly && contextId === undefined) {
      throw new BrowserProtocolError({
        code: "browser_readonly_realm_unavailable",
        message: "The Browser backend could not create an isolated read-only evaluation realm.",
        retryable: true,
        pageId: this.options.pageId,
        suggestedAction: "Wait for the current document to finish loading and retry browser_eval.",
      })
    }
    const result = await this.runtimeEvaluate(expression, {
      awaitPromise: true,
      returnByValue: true,
      ...(readonly ? { throwOnSideEffect: true } : {}),
      ...(timeout ? { timeout } : {}),
      userGesture: !readonly,
      ...(contextId ? { contextId } : {}),
    })
    const value = result.result.unserializableValue ?? result.result.value ?? null
    const encoded = JSON.stringify(value)
    if (encoded && Buffer.byteLength(encoded, "utf8") > 5 * 1024 * 1024) {
      throw new BrowserProtocolError({
        code: "browser_result_too_large",
        message: "Browser evaluation result exceeds the 5 MB protocol limit.",
        retryable: false,
        pageId: this.options.pageId,
        suggestedAction: "Return a smaller projection or use browser_read for bounded page content.",
      })
    }
    return value
  }

  private async action(action: BrowserAction): Promise<BrowserBackendResult> {
    const timeout = action.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS
    const actionType = action.type
    let state: ElementState | undefined
    let point: BrowserPoint | undefined
    let objectId: string | undefined

    if (action.type === "scroll" && !action.target) {
      await this.runtimeEvaluate(`globalThis.scrollBy(${action.deltaX}, ${action.deltaY})`, { returnByValue: true })
    } else if ("target" in action && action.target) {
      if (action.target.kind === "point") point = action.target
      else {
        objectId = await this.resolveLocatorObject(action.target)
        state = await this.waitForActionability(objectId, actionType, timeout, action.target)
        if (!state.box) this.throwNotVisible(action.target)
        point = { kind: "point", x: state.box.x + state.box.width / 2, y: state.box.y + state.box.height / 2 }
      }
    }

    switch (action.type) {
      case "click":
      case "dblclick":
        if (!point) throw new Error("Missing click target")
        await this.dispatchClick(point, action.type === "dblclick" ? 2 : 1, action.button, action.modifiers)
        break
      case "fill":
        if (!objectId) throw new Error("Missing fill target")
        await this.callOnObject(
          objectId,
          `function(value) {
            this.focus();
            if (this.isContentEditable) {
              this.textContent = value;
              this.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
              return;
            }
            const proto = Object.getPrototypeOf(this);
            const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
            if (descriptor?.set) descriptor.set.call(this, value); else this.value = value;
            this.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
            this.dispatchEvent(new Event("change", { bubbles: true }));
          }`,
          [action.value],
        )
        break
      case "type":
        if (action.target && objectId) await this.callOnObject(objectId, "function() { this.focus() }")
        if (action.delayMs && action.delayMs > 0) {
          for (const character of action.value) {
            await this.options.transport.send("Input.insertText", { text: character })
            await this.sleep(action.delayMs)
          }
        } else {
          await this.options.transport.send("Input.insertText", { text: action.value })
        }
        break
      case "press":
        if (action.target && objectId) await this.callOnObject(objectId, "function() { this.focus() }")
        await this.dispatchKey(action.key, action.modifiers)
        break
      case "select":
        if (!objectId) throw new Error("Missing select target")
        await this.callOnObject(
          objectId,
          `function(values) {
            const options = Array.from(this.options ?? []);
            const wanted = values.map((item) => typeof item === "string" ? { value: item } : item);
            const selectedIndexes = new Set();
            for (let index = 0; index < options.length; index++) {
              const option = options[index];
              if (wanted.some((item) =>
                item.value !== undefined ? option.value === item.value :
                item.label !== undefined ? option.label === item.label :
                item.index !== undefined ? options.indexOf(option) === item.index : false
              )) selectedIndexes.add(index);
            }
            if (!selectedIndexes.size) throw new Error("No requested option exists");
            for (let index = 0; index < options.length; index++) options[index].selected = selectedIndexes.has(index);
            this.dispatchEvent(new Event("input", { bubbles: true }));
            this.dispatchEvent(new Event("change", { bubbles: true }));
          }`,
          [action.values],
        )
        break
      case "setChecked":
        if (!objectId) throw new Error("Missing checkbox target")
        await this.callOnObject(
          objectId,
          `function(checked) {
            if (Boolean(this.checked) === checked) return;
            this.click();
            if (Boolean(this.checked) !== checked) throw new Error("Control did not reach requested checked state");
          }`,
          [action.checked],
        )
        break
      case "hover":
        if (!point) throw new Error("Missing hover target")
        await this.options.transport.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y })
        break
      case "drag": {
        const from = await this.targetPoint(action.from, timeout)
        const to = await this.targetPoint(action.to, timeout)
        const modifiers = this.modifierMask(action.modifiers)
        await this.options.transport.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: from.x,
          y: from.y,
          modifiers,
        })
        await this.options.transport.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: from.x,
          y: from.y,
          button: "left",
          clickCount: 1,
          modifiers,
        })
        for (let step = 1; step <= 10; step++) {
          await this.options.transport.send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: from.x + ((to.x - from.x) * step) / 10,
            y: from.y + ((to.y - from.y) * step) / 10,
            button: "left",
            modifiers,
          })
          await this.sleep(16)
        }
        await this.options.transport.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: to.x,
          y: to.y,
          button: "left",
          clickCount: 1,
          modifiers,
        })
        break
      }
      case "scroll":
        if (objectId) {
          await this.callOnObject(
            objectId,
            `function(deltaX, deltaY) {
              const canScroll = (element) => {
                const style = getComputedStyle(element);
                const scrollsX = /(auto|scroll|overlay)/.test(style.overflowX) && element.scrollWidth > element.clientWidth;
                const scrollsY = /(auto|scroll|overlay)/.test(style.overflowY) && element.scrollHeight > element.clientHeight;
                return (deltaX !== 0 && scrollsX) || (deltaY !== 0 && scrollsY);
              };
              let target = this;
              while (target && target !== document.documentElement && !canScroll(target)) target = target.parentElement;
              if (!target || !canScroll(target)) target = document.scrollingElement || document.documentElement;
              target.scrollBy(deltaX, deltaY);
            }`,
            [action.deltaX, action.deltaY],
          )
        } else if (point) {
          await this.options.transport.send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: point.x,
            y: point.y,
            deltaX: action.deltaX,
            deltaY: action.deltaY,
          })
        }
        break
    }

    let snapshot: unknown
    if (action.includeSnapshot) snapshot = await this.snapshot(undefined, 500)
    return {
      type: "action",
      pageId: this.options.pageId,
      action: action.type,
      ...(snapshot ? { snapshot } : {}),
    }
  }

  private async targetPoint(target: BrowserTarget, timeout: number): Promise<BrowserPoint> {
    if (target.kind === "point") return target
    const objectId = await this.resolveLocatorObject(target)
    const state = await this.waitForActionability(objectId, "drag", timeout, target)
    if (!state.box) this.throwNotVisible(target)
    return { kind: "point", x: state.box!.x + state.box!.width / 2, y: state.box!.y + state.box!.height / 2 }
  }

  private async dispatchClick(
    point: BrowserPoint,
    clickCount: number,
    button: "left" | "middle" | "right" = "left",
    modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">,
  ) {
    const modifierMask = this.modifierMask(modifiers)
    await this.options.transport.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button,
      clickCount,
      modifiers: modifierMask,
    })
    await this.options.transport.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button,
      clickCount,
      modifiers: modifierMask,
    })
  }

  private async dispatchKey(key: string, modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">) {
    const modifierMask = this.modifierMask(modifiers)
    const definition = keyDefinition(key)
    await this.options.transport.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: definition.key,
      code: definition.code,
      windowsVirtualKeyCode: definition.virtualKeyCode,
      nativeVirtualKeyCode: definition.virtualKeyCode,
      ...(!modifierMask && definition.text ? { text: definition.text, unmodifiedText: definition.text } : {}),
      modifiers: modifierMask,
    })
    await this.options.transport.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: definition.key,
      code: definition.code,
      windowsVirtualKeyCode: definition.virtualKeyCode,
      nativeVirtualKeyCode: definition.virtualKeyCode,
      modifiers: modifierMask,
    })
  }

  private modifierMask(modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">): number {
    let mask = 0
    for (const modifier of modifiers ?? []) {
      if (modifier === "Alt") mask |= 1
      if (modifier === "Control" || (modifier === "ControlOrMeta" && !this.isMac())) mask |= 2
      if (modifier === "Meta" || (modifier === "ControlOrMeta" && this.isMac())) mask |= 4
      if (modifier === "Shift") mask |= 8
    }
    return mask
  }

  private isMac() {
    return (this.options.platform ?? process.platform) === "darwin"
  }

  private async captureCheckpoint(): Promise<BrowserCheckpoint> {
    const cookies = await this.options.transport
      .send<{ cookies?: Array<Record<string, unknown>> }>("Network.getAllCookies")
      .then((result) => result.cookies ?? [])
    const state = await this.runtimeValue<{
      url?: string
      origin?: string
      localStorage?: Record<string, string>
      sessionStorage?: Record<string, string>
      viewport?: { width: number; height: number }
      scroll?: { x: number; y: number }
      formState?: BrowserCheckpoint["formState"]
    }>(`(() => {
      const captureStorage = (storage) => {
        const result = {};
        let chars = 0;
        for (const [rawKey, rawValue] of Object.entries(storage).slice(0, 1000)) {
          const key = String(rawKey).slice(0, 10000);
          const value = String(rawValue).slice(0, 1000000);
          if (chars + key.length + value.length > 8 * 1024 * 1024) break;
          chars += key.length + value.length;
          result[key] = value;
        }
        return result;
      };
      const captureStorageSafely = (name) => {
        try {
          return captureStorage(globalThis[name]);
        } catch {
          return {};
        }
      };
      const formState = [];
      let formChars = 0;
      for (const element of Array.from(document.querySelectorAll('input:not([type=password]):not([type=file]),textarea,select,[contenteditable=true]')).slice(0, 500)) {
        const selector = (() => {
          if (element.id) return '#' + CSS.escape(element.id);
          const parts = [];
          let current = element;
          while (current && current !== document.documentElement) {
            const tag = current.tagName.toLowerCase();
            const siblings = Array.from(current.parentElement?.children ?? []).filter((entry) => entry.tagName === current.tagName);
            parts.unshift(tag + ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')');
            current = current.parentElement;
          }
          return parts.join(' > ');
        })().slice(0, 10000);
        let entry;
        if (element instanceof HTMLSelectElement) entry = { selector, selectedValues: Array.from(element.selectedOptions).slice(0, 1000).map((option) => option.value.slice(0, 20000)) };
        else if (element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)) entry = { selector, checked: element.checked };
        else if (element.isContentEditable) entry = { selector, value: (element.textContent ?? '').slice(0, 100000), contentEditable: true };
        else entry = { selector, value: String(element.value ?? '').slice(0, 100000) };
        const size = JSON.stringify(entry).length;
        if (formChars + size > 8 * 1024 * 1024) break;
        formChars += size;
        formState.push(entry);
      }
      return {
        url: location.href,
        origin: location.origin,
        localStorage: captureStorageSafely('localStorage'),
        sessionStorage: captureStorageSafely('sessionStorage'),
        viewport: { width: innerWidth, height: innerHeight },
        scroll: { x: scrollX, y: scrollY },
        formState,
      };
    })()`)
    const origin = state?.origin && state.origin !== "null" ? state.origin : undefined
    return BrowserCheckpointSchema.parse({
      url: state?.url ?? "about:blank",
      cookies,
      origins: origin
        ? [
            {
              origin,
              localStorage: state?.localStorage ?? {},
              sessionStorage: state?.sessionStorage ?? {},
            },
          ]
        : [],
      viewport: state?.viewport ?? { width: 1280, height: 720 },
      scroll: state?.scroll ?? { x: 0, y: 0 },
      formState: state?.formState ?? [],
    })
  }

  private async restoreCheckpoint(checkpoint: BrowserCheckpoint): Promise<{ restored: true }> {
    if (checkpoint.cookies.length) {
      await this.options.transport.send("Network.setCookies", { cookies: checkpoint.cookies })
    }
    await this.applyEmulation({ viewport: checkpoint.viewport })
    if (checkpoint.url && checkpoint.url !== "about:blank") {
      this.beginLoading()
      const navigation = await this.options.transport.send<{ errorText?: string }>("Page.navigate", {
        url: checkpoint.url,
      })
      if (navigation.errorText) {
        throw new BrowserProtocolError({
          code: "browser_checkpoint_navigation_failed",
          message: navigation.errorText,
          retryable: true,
          pageId: this.options.pageId,
          url: checkpoint.url,
        })
      }
      await this.wait({ type: "load", state: "load" }, 10_000)
    }
    let origin: string | undefined
    try {
      origin = new URL(checkpoint.url).origin
    } catch {}
    const storage = checkpoint.origins.find((entry) => entry.origin === origin)
    if (storage) {
      await this.runtimeValue(`(() => {
        localStorage.clear();
        sessionStorage.clear();
        for (const [key, value] of Object.entries(${JSON.stringify(storage.localStorage)})) localStorage.setItem(key, value);
        for (const [key, value] of Object.entries(${JSON.stringify(storage.sessionStorage)})) sessionStorage.setItem(key, value);
        return true;
      })()`)
      this.beginLoading()
      await this.options.transport.send("Page.reload")
      await this.wait({ type: "load", state: "load" }, 10_000)
    }
    await this.runtimeValue(`(() => {
      for (const state of ${JSON.stringify(checkpoint.formState)}) {
        let element;
        try { element = document.querySelector(state.selector) } catch { continue }
        if (!element) continue;
        if (state.selectedValues && element instanceof HTMLSelectElement) {
          for (const option of element.options) option.selected = state.selectedValues.includes(option.value);
        } else if (state.checked !== undefined && element instanceof HTMLInputElement) {
          element.checked = state.checked;
        } else if (state.contentEditable) {
          element.textContent = state.value ?? '';
        } else if ('value' in element) {
          element.value = state.value ?? '';
        }
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }
      scrollTo(${JSON.stringify(checkpoint.scroll.x)}, ${JSON.stringify(checkpoint.scroll.y)});
      return true;
    })()`)
    return { restored: true }
  }

  private async waitForActionability(
    objectId: string,
    action: BrowserAction["type"] | "drag" | "screenshot",
    timeoutMs: number,
    locator: BrowserLocator,
  ): Promise<ElementState> {
    const deadline = this.now() + timeoutMs
    let state: ElementState | undefined
    let previousBox: ElementState["box"] | undefined
    do {
      const remainingMs = Math.max(1, deadline - this.now())
      const sampled = await this.callOnObject<ElementSample>(
        objectId,
        actionabilityFunction,
        [action, previousBox === undefined],
        remainingMs,
      )
      state = {
        ...sampled,
        stable: previousBox !== undefined && boxesAreStable(previousBox, sampled.box),
      }
      previousBox = sampled.box
      const needsEditable = action === "fill" || action === "type"
      const needsEnabled = !["hover", "scroll", "screenshot"].includes(action)
      const needsEvents = action !== "screenshot"
      if (
        state.visible &&
        state.stable &&
        (!needsEvents || state.receivesEvents) &&
        (!needsEnabled || state.enabled) &&
        (!needsEditable || state.editable)
      ) {
        return { ...state, box: await this.absoluteBox(objectId, state.box) }
      }
      if (this.now() < deadline) await this.sleep(Math.min(ACTION_STABILITY_POLL_MS, deadline - this.now()))
    } while (this.now() < deadline)

    if (state?.obstruction) {
      throw new BrowserProtocolError({
        code: "browser_obstructed",
        message: "The target is covered by another element and cannot receive pointer events.",
        retryable: true,
        pageId: this.options.pageId,
        locator,
        obstruction: state.obstruction,
        suggestedAction: "Inspect or close the obstructing dialog/overlay, then take a fresh snapshot.",
      })
    }
    if (state && !state.enabled) {
      throw new BrowserProtocolError({
        code: "browser_target_disabled",
        message: "The target is disabled.",
        retryable: true,
        pageId: this.options.pageId,
        locator,
        suggestedAction: "Wait for the target to become enabled or inspect the page state.",
      })
    }
    this.throwNotVisible(locator)
  }

  private async absoluteBox(objectId: string, fallback: ElementState["box"]): Promise<ElementState["box"]> {
    const frameOffset = this.objectFrameOffsets.get(objectId)
    this.objectFrameOffsets.delete(objectId)
    const model = await this.options.transport
      .send<{ model?: { border?: unknown[]; content?: unknown[] } }>("DOM.getBoxModel", { objectId })
      .catch(() => null)
    const quad = model?.model?.border ?? model?.model?.content
    if (!Array.isArray(quad) || quad.length !== 8 || quad.some((value: unknown) => !Number.isFinite(value))) {
      return frameOffset && fallback
        ? { ...fallback, x: fallback.x + frameOffset.x, y: fallback.y + frameOffset.y }
        : fallback
    }
    const xs = [Number(quad[0]), Number(quad[2]), Number(quad[4]), Number(quad[6])]
    const ys = [Number(quad[1]), Number(quad[3]), Number(quad[5]), Number(quad[7])]
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
  }

  private throwNotVisible(locator: BrowserLocator): never {
    throw new BrowserProtocolError({
      code: "browser_target_not_actionable",
      message: "The target is not visible, stable, or actionable.",
      retryable: true,
      pageId: this.options.pageId,
      locator,
      suggestedAction: "Take a fresh snapshot and choose a visible unique target.",
    })
  }

  private async resolveLocatorObject(locator: BrowserLocator): Promise<string> {
    await this.validateLocator(locator)
    if (locator.kind === "ref") {
      const entry = await this.resolveRef(locator.snapshotId, locator.ref)
      const resolved = await this.options.transport
        .send<{ object?: { objectId?: string } }>("DOM.resolveNode", {
          backendNodeId: entry.backendNodeId,
          ...(entry.frameId && this.frameContexts.has(entry.frameId)
            ? { executionContextId: this.frameContexts.get(entry.frameId) }
            : {}),
        })
        .catch(() => this.throwStaleRef(locator.snapshotId, locator.ref))
      const objectId = resolved?.object?.objectId
      if (!objectId) this.throwStaleRef(locator.snapshotId, locator.ref)
      return objectId
    }

    const location = await this.contextForLocator(locator)
    const contextId = location.contextId
    await this.assertUniqueScopes(locator, contextId)
    const expression = this.locatorArrayExpression(locator)
    const summary = await this.runtimeValue<LocatorSummary>(
      `(() => {
        const matches = ${expression};
        return {
          count: matches.length,
          candidates: matches.slice(0, 5).map((el) => ({
            tag: el.tagName?.toLowerCase(),
            role: el.getAttribute?.("role"),
            name: el.getAttribute?.("aria-label") || el.innerText?.trim()?.slice(0, 120) || "",
            id: el.id || undefined,
          })),
        };
      })()`,
      contextId,
    )
    if (!summary || summary.count === 0) this.throwMissing(locator)
    if (summary.count !== 1) {
      throw new BrowserProtocolError({
        code: "browser_locator_ambiguous",
        message: `Locator matched ${summary.count} elements; exactly one is required.`,
        retryable: true,
        pageId: this.options.pageId,
        locator,
        obstruction: { candidates: summary.candidates },
        suggestedAction:
          "Use exact matching, scope the locator to a stable container, choose a role/test-id/CSS locator, or use a fresh snapshot ref.",
      })
    }
    const result = await this.runtimeEvaluate(`(${expression})[0]`, {
      returnByValue: false,
      ...(contextId ? { contextId } : {}),
    })
    if (!result.result.objectId) this.throwMissing(locator)
    if (location.x || location.y) this.objectFrameOffsets.set(result.result.objectId, { x: location.x, y: location.y })
    return result.result.objectId
  }

  private async assertUniqueScopes(locator: BrowserLocator, contextId?: number): Promise<void> {
    if (!locator.within) return
    await this.assertUniqueScopes(locator.within, contextId)
    await this.resolveLocatorInContext(locator.within, contextId)
  }

  private async validateLocator(locator: BrowserLocator): Promise<void> {
    if (locator.within) await this.validateLocator(locator.within)
    for (const frame of locator.framePath ?? []) await this.validateLocator(frame)
    if (locator.kind === "css") {
      if (/(^|[^-]):(?:has-text|text|text-is|text-matches)\s*\(|(?:^|\s)>>|^(?:css|xpath|text)=/i.test(locator.value)) {
        this.throwInvalidSelector(locator)
      }
      try {
        await this.runtimeValue(`document.querySelector(${JSON.stringify(locator.value)}) !== undefined`)
      } catch {
        this.throwInvalidSelector(locator)
      }
      return
    }
    if (locator.kind === "xpath") {
      try {
        await this.runtimeValue(
          `document.evaluate(${JSON.stringify(locator.value)}, document, null, XPathResult.ANY_TYPE, null) !== undefined`,
        )
      } catch {
        this.throwInvalidSelector(locator)
      }
    }
  }

  private throwInvalidSelector(locator: BrowserLocator): never {
    throw new BrowserProtocolError({
      code: "browser_invalid_selector",
      message:
        "The selector is invalid. CSS locators accept only standard CSS; Playwright selector extensions are not supported.",
      retryable: false,
      pageId: this.options.pageId,
      locator,
      suggestedAction:
        'Use { kind: "role", role: "button", name: "Continue with Holos" } or { kind: "text", text: "Continue with Holos" }.',
    })
  }

  private throwMissing(locator: BrowserLocator): never {
    throw new BrowserProtocolError({
      code: "browser_locator_not_found",
      message: "Locator did not match an element in the current document.",
      retryable: true,
      pageId: this.options.pageId,
      locator,
      suggestedAction: "Take a fresh browser_snapshot and construct the locator from current page state.",
    })
  }

  private async contextForLocator(
    locator: BrowserLocator,
  ): Promise<{ contextId: number | undefined; x: number; y: number }> {
    let contextId = this.mainFrameId ? this.frameContexts.get(this.mainFrameId) : undefined
    let x = 0
    let y = 0
    for (const frameLocator of locator.framePath ?? []) {
      const objectId = await this.resolveLocatorInContext(frameLocator, contextId)
      const frameBox = await this.callOnObject<{ x: number; y: number }>(
        objectId,
        "function() { const rect = this.getBoundingClientRect(); return { x: rect.x + this.clientLeft, y: rect.y + this.clientTop } }",
      )
      x += Number(frameBox?.x ?? 0)
      y += Number(frameBox?.y ?? 0)
      const described = await this.options.transport.send<CdpNodeResult>("DOM.describeNode", {
        objectId,
        depth: 1,
        pierce: true,
      })
      const frameId = described?.node?.frameId
      if (!frameId) {
        throw new BrowserProtocolError({
          code: "browser_frame_not_found",
          message: "The frame locator did not resolve to a browsing context.",
          retryable: true,
          pageId: this.options.pageId,
          locator: frameLocator,
        })
      }
      contextId = await this.waitForFrameContext(frameId)
      await this.runtimeEvaluate(webVitalsBootstrap, { returnByValue: true, contextId }).catch(() => undefined)
    }
    return { contextId, x, y }
  }

  private async resolveLocatorInContext(locator: BrowserLocator, contextId?: number): Promise<string> {
    const withoutFrames = { ...locator, framePath: undefined } as BrowserLocator
    const expression = this.locatorArrayExpression(withoutFrames)
    const summary = await this.runtimeValue<LocatorSummary>(
      `(() => { const matches = ${expression}; return { count: matches.length, candidates: [] }; })()`,
      contextId,
    )
    if (summary?.count !== 1) {
      if (!summary?.count) this.throwMissing(locator)
      throw new BrowserProtocolError({
        code: "browser_locator_ambiguous",
        message: `Frame locator matched ${summary.count} elements; exactly one is required.`,
        retryable: true,
        pageId: this.options.pageId,
        locator,
      })
    }
    const result = await this.runtimeEvaluate(`(${expression})[0]`, {
      returnByValue: false,
      ...(contextId ? { contextId } : {}),
    })
    if (!result.result.objectId) this.throwMissing(locator)
    return result.result.objectId
  }

  private async waitForFrameContext(frameId: string): Promise<number> {
    const deadline = this.now() + 2_000
    while (this.now() < deadline) {
      const contextId = this.frameContexts.get(frameId)
      if (contextId) return contextId
      await this.sleep(25)
    }
    throw new BrowserProtocolError({
      code: "browser_frame_context_unavailable",
      message: "The target frame has no active execution context.",
      retryable: true,
      pageId: this.options.pageId,
    })
  }

  private locatorArrayExpression(locator: BrowserLocator): string {
    const descriptor = JSON.stringify(this.locatorDescriptor(locator))
    const within = locator.within ? this.locatorArrayExpression(locator.within) : "[document.documentElement]"
    return `globalThis.__synergyBrowserResolve(${descriptor}, (${within})[0] ?? document.documentElement)`
  }

  private locatorDescriptor(locator: BrowserLocator): Record<string, unknown> {
    const { within: _within, framePath: _framePath, ...descriptor } = locator
    return descriptor
  }

  private async wait(condition: BrowserWaitCondition, timeoutMs: number) {
    const deadline = this.now() + timeoutMs
    do {
      if (await this.conditionMatches(condition)) return
      await this.sleep(POLL_MS)
    } while (this.now() < deadline)

    throw new BrowserProtocolError({
      code: "browser_wait_timeout",
      message: `Browser wait timed out after ${timeoutMs}ms.`,
      retryable: true,
      pageId: this.options.pageId,
      ...(condition.type === "locator" ? { locator: condition.locator } : {}),
      suggestedAction: "Inspect the current page state before choosing another wait condition.",
    })
  }

  private async conditionMatches(condition: BrowserWaitCondition): Promise<boolean> {
    switch (condition.type) {
      case "load":
        if (condition.state === "networkidle") return !this.loading && this.inflightRequests.size === 0
        if (condition.state === "domcontentloaded") return this.lifecycle.has("DOMContentLoaded")
        return this.lifecycle.has("load") || (!this.loading && this.lifecycle.size === 0)
      case "url": {
        const page = await this.pageState()
        return condition.match === "equals" ? page.url === condition.value : page.url.includes(condition.value)
      }
      case "title": {
        const page = await this.pageState()
        return condition.match === "equals" ? page.title === condition.value : page.title.includes(condition.value)
      }
      case "text": {
        return Boolean(
          await this.runtimeValue<boolean>(`(() => {
            const text = document.body?.innerText ?? "";
            const results = ${JSON.stringify(condition.values)}.map((value) => text.includes(value));
            return ${JSON.stringify(condition.match)} === "all" ? results.every(Boolean) : results.some(Boolean);
          })()`),
        )
      }
      case "locator": {
        try {
          const objectId = await this.resolveLocatorObject(condition.locator)
          const state = await this.callOnObject<ElementSample>(objectId, actionabilityFunction, ["wait"])
          if (condition.state === "attached") return true
          if (condition.state === "detached") return false
          if (condition.state === "visible") return state.visible
          if (condition.state === "hidden") return !state.visible
          if (condition.state === "enabled") return state.enabled
          return !state.enabled
        } catch (error) {
          if (error instanceof BrowserProtocolError && error.code === "browser_locator_not_found") {
            return condition.state === "detached" || condition.state === "hidden"
          }
          throw error
        }
      }
      case "download":
        if (!this.latestDownload) return false
        this.latestDownload = null
        return true
      case "dialog":
        return this.latestDialog !== null
    }
  }

  private async screenshot(
    command: Extract<BrowserParsedBackendCommand, { type: "screenshot" }>,
  ): Promise<BrowserBackendResult> {
    let clip = command.clip
    if (command.target) {
      const objectId = await this.resolveLocatorObject(command.target)
      const state = await this.waitForActionability(objectId, "screenshot", DEFAULT_ACTION_TIMEOUT_MS, command.target)
      if (!state.box) this.throwNotVisible(command.target)
      clip = state.box!
    } else if (command.fullPage) {
      const metrics = await this.options.transport.send<{
        cssContentSize?: { width?: number; height?: number }
        contentSize?: { width?: number; height?: number }
      }>("Page.getLayoutMetrics")
      const size = metrics?.cssContentSize ?? metrics?.contentSize
      if (size) clip = { x: 0, y: 0, width: Number(size.width), height: Number(size.height) }
    }
    if (clip && (clip.width > 32_768 || clip.height > 32_768 || clip.width * clip.height > 100_000_000)) {
      throw new BrowserProtocolError({
        code: "browser_screenshot_dimensions_exceeded",
        message: "The requested screenshot exceeds the Browser dimension limit.",
        retryable: false,
        pageId: this.options.pageId,
        suggestedAction: "Capture a smaller clip, locator, or viewport screenshot.",
      })
    }

    const result = await this.options.transport.send<{ data?: string }>("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: Boolean(command.fullPage || clip),
      ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
    })
    const encoded = String(result?.data ?? "")
    if (!encoded) {
      throw new BrowserProtocolError({
        code: "browser_screenshot_failed",
        message: "The Browser backend returned no screenshot data.",
        retryable: true,
        pageId: this.options.pageId,
      })
    }
    if (Buffer.byteLength(encoded, "base64") > MAX_SCREENSHOT_BYTES) {
      throw new BrowserProtocolError({
        code: "browser_screenshot_too_large",
        message: "The screenshot exceeds the 25 MB Browser result limit.",
        retryable: false,
        pageId: this.options.pageId,
        suggestedAction: "Capture the viewport, a locator, or a smaller clip instead of the full page.",
      })
    }
    const viewport =
      clip ??
      (await this.runtimeValue<{ x: number; y: number; width: number; height: number }>(
        `({ x: 0, y: 0, width: innerWidth, height: innerHeight })`,
      ))
    return {
      type: "screenshot",
      pageId: this.options.pageId,
      dataUrl: `data:image/png;base64,${encoded}`,
      width: Math.round(viewport?.width ?? 0),
      height: Math.round(viewport?.height ?? 0),
    }
  }

  private async read(command: Extract<BrowserParsedBackendCommand, { type: "read" }>) {
    const objectId = command.target ? await this.resolveLocatorObject(command.target) : undefined
    const property = command.format === "html" ? "outerHTML" : "innerText"
    const result = objectId
      ? await this.callOnObject<{ content: string; length: number }>(
          objectId,
          `function(maxChars) {
            const value = String(this.${property} ?? "");
            return { content: value.slice(0, maxChars), length: value.length };
          }`,
          [command.maxChars],
        )
      : await this.runtimeValue<{ content: string; length: number }>(`(() => {
          const value = String(document.documentElement?.${property} ?? "");
          return { content: value.slice(0, ${command.maxChars}), length: value.length };
        })()`)
    const value = result?.content ?? ""
    const truncated = (result?.length ?? 0) > value.length
    if (command.format !== "markdown") return { format: command.format, content: value, truncated }
    return {
      format: "markdown",
      content: value
        .replace(/\n{3,}/g, "\n\n")
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n"),
      truncated,
    }
  }

  private async inspect(locator: BrowserLocator, computedStyles?: string[]) {
    const objectId = await this.resolveLocatorObject(locator)
    const [details, listenerResult, accessibilityResult] = await Promise.all([
      this.callOnObject<Record<string, unknown>>(
        objectId,
        `function(styleNames) {
        const rect = this.getBoundingClientRect();
        const styles = getComputedStyle(this);
        const selectedStyles = {};
        for (const name of styleNames ?? []) selectedStyles[name] = styles.getPropertyValue(name);
        return {
          tag: this.tagName?.toLowerCase(),
          html: this.outerHTML?.slice(0, 20000),
          attributes: Object.fromEntries(Array.from(this.attributes ?? []).slice(0, 200).map((attr) => [attr.name, attr.value.slice(0, 20000)])),
          box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          computedStyles: selectedStyles,
          accessibility: {
            role: this.getAttribute?.("role"),
            name: this.getAttribute?.("aria-label") || this.innerText?.trim()?.slice(0, 500) || "",
            disabled: this.matches?.(":disabled") || this.getAttribute?.("aria-disabled") === "true",
          },
        };
      }`,
        [computedStyles ?? ["display", "position", "color", "background-color", "font-size", "z-index", "overflow"]],
      ),
      this.options.transport
        .send<{ listeners?: CdpEventListener[] }>("DOMDebugger.getEventListeners", {
          objectId,
          depth: 1,
          pierce: true,
        })
        .catch(() => ({ listeners: [] })),
      this.options.transport
        .send<{ nodes?: unknown[] }>("Accessibility.getPartialAXTree", { objectId, fetchRelatives: false })
        .catch(() => ({ nodes: [] })),
    ])
    const listeners = (listenerResult?.listeners ?? []).slice(0, 200).map((listener) => ({
      type: String(listener?.type ?? ""),
      useCapture: Boolean(listener?.useCapture),
      passive: Boolean(listener?.passive),
      once: Boolean(listener?.once),
      scriptId: listener?.scriptId === undefined ? undefined : String(listener.scriptId),
      lineNumber: Number(listener?.lineNumber ?? 0),
      columnNumber: Number(listener?.columnNumber ?? 0),
    }))
    const accessibility = accessibilityResult?.nodes?.[0]
    return {
      ...details,
      listeners,
      ...(accessibility ? { accessibilityNode: accessibility } : {}),
    }
  }

  private console(command: Extract<BrowserParsedBackendCommand, { type: "console" }>) {
    if (command.action === "clear") {
      this.consoleEntries = []
      return { entries: [], page: 0, total: 0 }
    }
    let entries = this.consoleEntries
    if (command.level) entries = entries.filter((entry) => entry.level === command.level)
    if (command.filter)
      entries = entries.filter((entry) => `${entry.text} ${entry.url ?? ""}`.includes(command.filter!))
    if (command.action === "get")
      return this.redactConsoleEntry(entries.find((entry) => entry.id === command.id) ?? null)
    const page = command.page ?? 0
    const pageSize = command.pageSize ?? 100
    const start = page * pageSize
    return {
      entries: entries.slice(start, start + pageSize).map((entry) => this.redactConsoleEntry(entry)),
      page,
      total: entries.length,
    }
  }

  private async network(command: Extract<BrowserParsedBackendCommand, { type: "network" }>) {
    if (command.action === "clear") {
      this.networkEntries.clear()
      return { requests: [], page: 0, total: 0 }
    }
    let entries = Array.from(this.networkEntries.values())
    if (command.resourceTypes?.length)
      entries = entries.filter((entry) => entry.resourceType && command.resourceTypes!.includes(entry.resourceType))
    if (command.status !== undefined) entries = entries.filter((entry) => entry.status === command.status)
    if (command.action === "get") {
      const entry = entries.find((item) => item.id === command.id)
      if (!entry) return null
      let body: string | undefined
      let base64Encoded = false
      let bodyTruncated = false
      if (command.includeBody) {
        try {
          const response = await this.options.transport.send<{ body?: string; base64Encoded?: boolean }>(
            "Network.getResponseBody",
            { requestId: entry.id },
          )
          const raw = String(response?.body ?? "")
          const maxBodyBytes = command.maxBodyBytes ?? 200_000
          base64Encoded = Boolean(response?.base64Encoded)
          if (base64Encoded) {
            const maxBase64Chars = Math.floor(maxBodyBytes / 3) * 4
            body = raw.slice(0, maxBase64Chars)
            bodyTruncated = raw.length > body.length
          } else {
            const encoded = new TextEncoder().encode(raw)
            body = new TextDecoder().decode(encoded.slice(0, maxBodyBytes))
            bodyTruncated = encoded.byteLength > maxBodyBytes
          }
          if (!command.includeSensitive && !base64Encoded) body = redactBrowserText(body)
        } catch {}
      }
      return {
        ...(command.includeSensitive ? entry : this.redactNetworkEntry(entry)),
        ...(body !== undefined ? { body, base64Encoded, bodyTruncated } : {}),
      }
    }
    const page = command.page ?? 0
    const pageSize = command.pageSize ?? 100
    const start = page * pageSize
    return {
      requests: entries
        .slice(start, start + pageSize)
        .map((entry) => (command.includeSensitive ? entry : this.redactNetworkEntry(entry))),
      page,
      total: entries.length,
    }
  }

  private redactNetworkEntry(entry: NetworkEntry): NetworkEntry {
    return {
      ...entry,
      url: redactBrowserURL(entry.url),
      requestHeaders: redactBrowserHeaders(entry.requestHeaders ?? {}),
      responseHeaders: redactBrowserHeaders(entry.responseHeaders ?? {}),
      ...(entry.requestPostData ? { requestPostData: redactBrowserText(entry.requestPostData) } : {}),
    }
  }

  private async performance(action: "measure" | "startTrace" | "stopTrace") {
    if (action === "startTrace") {
      if (this.tracing) {
        throw new BrowserProtocolError({
          code: "browser_trace_already_running",
          message: "A performance trace is already running for this page.",
          retryable: false,
          pageId: this.options.pageId,
        })
      }
      this.traceChunks = []
      this.traceBytes = 0
      this.traceTruncated = false
      this.tracing = true
      await this.options.transport.send("Tracing.start", {
        categories: "devtools.timeline,loading,blink.user_timing,v8.execute",
        transferMode: "ReportEvents",
      })
      return { tracing: true }
    }
    if (action === "stopTrace") {
      if (!this.tracing) {
        throw new BrowserProtocolError({
          code: "browser_trace_not_running",
          message: "No performance trace is active for this page.",
          retryable: false,
          pageId: this.options.pageId,
        })
      }
      const completed = new Promise<void>((resolve) => {
        this.traceComplete = resolve
      })
      await this.options.transport.send("Tracing.end")
      const completion = await Promise.race([completed.then(() => true), this.sleep(5_000).then(() => false)])
      if (!completion) {
        this.tracing = false
        this.traceComplete = null
        throw new BrowserProtocolError({
          code: "browser_trace_stop_timeout",
          message: "The Browser backend did not finish the performance trace within 5 seconds.",
          retryable: true,
          pageId: this.options.pageId,
        })
      }
      this.tracing = false
      const summary = this.traceSummary(this.traceChunks)
      return { tracing: false, traceEvents: this.traceChunks, traceTruncated: this.traceTruncated, summary }
    }
    const metrics = await this.options.transport.send<{ metrics?: Array<{ name: string; value: number }> }>(
      "Performance.getMetrics",
    )
    const metricMap = Object.fromEntries((metrics.metrics ?? []).map((metric) => [metric.name, metric.value]))
    const vitals = await this.runtimeValue<Record<string, unknown>>(`globalThis.__synergyWebVitals ?? {}`)
    const resources = await this.runtimeValue<unknown[]>(
      `performance.getEntriesByType("resource").slice(-200).map((entry) => ({ name: entry.name, duration: entry.duration, transferSize: entry.transferSize, initiatorType: entry.initiatorType }))`,
    )
    return { metrics: metricMap, webVitals: vitals ?? {}, resources: resources ?? [] }
  }

  private traceSummary(events: unknown[]) {
    let longTaskCount = 0
    let longTaskDuration = 0
    for (const event of events) {
      const record = objectRecord(event)
      const durationMs = Number(record?.dur ?? 0) / 1_000
      if ((record?.name === "RunTask" || record?.name === "Task") && durationMs >= 50) {
        longTaskCount++
        longTaskDuration += durationMs
      }
    }
    return { eventCount: events.length, longTaskCount, longTaskDurationMs: Math.round(longTaskDuration * 100) / 100 }
  }

  private async audit(categories?: Array<"accessibility" | "semantic" | "seo" | "best-practices">) {
    const requested = new Set(categories ?? ["accessibility", "semantic", "seo", "best-practices"])
    return this.runtimeValue(
      `(() => {
        const requested = new Set(${JSON.stringify(Array.from(requested))});
        const issues = [];
        let issueCount = 0;
        const add = (category, code, message, selector) => {
          issueCount++;
          if (issues.length < 500) issues.push({ category, code, message, selector });
        };
        const selector = (el) => el.id ? "#" + CSS.escape(el.id) : el.tagName?.toLowerCase();
        if (requested.has("accessibility")) {
          for (const img of document.querySelectorAll("img:not([alt])")) add("accessibility", "image-missing-alt", "Image is missing alt text.", selector(img));
          for (const input of document.querySelectorAll("input,select,textarea")) {
            if (!input.labels?.length && !input.getAttribute("aria-label") && !input.getAttribute("aria-labelledby")) add("accessibility", "control-missing-name", "Form control has no accessible name.", selector(input));
          }
          for (const el of document.querySelectorAll("[role=button],button,a[href],input,select,textarea")) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && (rect.width < 24 || rect.height < 24)) add("accessibility", "small-target", "Interactive target is smaller than 24 CSS pixels.", selector(el));
          }
        }
        if (requested.has("semantic")) {
          if (document.querySelectorAll("h1").length !== 1) add("semantic", "h1-count", "Page should have exactly one h1.", "h1");
          if (!document.querySelector("main,[role=main]")) add("semantic", "missing-main", "Page has no main landmark.", "body");
        }
        if (requested.has("seo")) {
          if (!document.title.trim()) add("seo", "missing-title", "Page title is empty.", "head");
          if (!document.querySelector('meta[name="description"][content]')) add("seo", "missing-description", "Meta description is missing.", "head");
          if (!document.documentElement.lang) add("seo", "missing-lang", "Document language is missing.", "html");
        }
        if (requested.has("best-practices")) {
          for (const link of document.querySelectorAll('a[target="_blank"]:not([rel~="noopener"])')) add("best-practices", "unsafe-blank-target", "target=_blank link is missing rel=noopener.", selector(link));
          for (const form of document.querySelectorAll('form[action^="http:"]')) add("best-practices", "insecure-form", "Form submits over insecure HTTP.", selector(form));
        }
        return { url: location.href, categories: Array.from(requested), issues, issueCount, truncated: issueCount > issues.length };
      })()`,
    )
  }

  private async applyEmulation(emulation: BrowserEmulation) {
    if (emulation.viewport || emulation.mobile !== undefined) {
      const current = emulation.viewport
        ? undefined
        : await this.runtimeValue<{ width: number; height: number }>(`({ width: innerWidth, height: innerHeight })`)
      const viewport = emulation.viewport ?? {
        width: Math.max(1, Math.round(current?.width ?? 1280)),
        height: Math.max(1, Math.round(current?.height ?? 720)),
      }
      await this.options.transport.send("Emulation.setDeviceMetricsOverride", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: emulation.viewport?.deviceScaleFactor ?? 1,
        mobile: emulation.mobile ?? false,
        screenWidth: viewport.width,
        screenHeight: viewport.height,
      })
    }
    if (emulation.touch !== undefined) {
      await this.options.transport.send("Emulation.setTouchEmulationEnabled", {
        enabled: emulation.touch,
        maxTouchPoints: emulation.touch ? 5 : 0,
      })
    }
    const mediaFeatures = [
      ...(emulation.colorScheme ? [{ name: "prefers-color-scheme", value: emulation.colorScheme }] : []),
      ...(emulation.reducedMotion ? [{ name: "prefers-reduced-motion", value: emulation.reducedMotion }] : []),
      ...(emulation.forcedColors ? [{ name: "forced-colors", value: emulation.forcedColors }] : []),
    ]
    if (mediaFeatures.length)
      await this.options.transport.send("Emulation.setEmulatedMedia", { features: mediaFeatures })
    if (emulation.locale) await this.options.transport.send("Emulation.setLocaleOverride", { locale: emulation.locale })
    if (emulation.timezone)
      await this.options.transport.send("Emulation.setTimezoneOverride", { timezoneId: emulation.timezone })
    if (emulation.cpuThrottlingRate) {
      await this.options.transport.send("Emulation.setCPUThrottlingRate", { rate: emulation.cpuThrottlingRate })
    }
    if (emulation.networkProfile) {
      const profile = networkProfiles[emulation.networkProfile]
      await this.options.transport.send("Network.emulateNetworkConditions", profile)
    }
  }

  private async runtimeValue<T>(expression: string, contextId?: number): Promise<T | undefined> {
    const result = await this.runtimeEvaluate(expression, {
      awaitPromise: true,
      returnByValue: true,
      ...(contextId ? { contextId } : {}),
    })
    return result.result.value as T | undefined
  }

  private async isolatedContext(): Promise<number | undefined> {
    const frameId = this.mainFrameId
    if (!frameId) return undefined
    const existing = this.isolatedContexts.get(frameId)
    if (existing) return existing
    const result = await this.options.transport.send<{ executionContextId?: number }>("Page.createIsolatedWorld", {
      frameId,
      worldName: `synergy-readonly-${this.options.pageId}`,
      grantUniveralAccess: false,
    })
    if (typeof result.executionContextId !== "number") return undefined
    this.isolatedContexts.set(frameId, result.executionContextId)
    return result.executionContextId
  }

  private async runtimeEvaluate(expression: string, params: Record<string, unknown>): Promise<RuntimeResult> {
    const result = await this.options.transport.send<RuntimeResult>("Runtime.evaluate", {
      expression,
      includeCommandLineAPI: false,
      ...params,
    })
    if (result.exceptionDetails) {
      const message =
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Browser evaluation failed."
      if (params.throwOnSideEffect === true && /possible side-effect/i.test(message)) {
        throw new BrowserProtocolError({
          code: "browser_readonly_side_effect_rejected",
          message: "Chromium could not prove that this read-only expression is free of side effects.",
          retryable: false,
          pageId: this.options.pageId,
          suggestedAction:
            "Use a simpler expression, split the inspection into smaller reads, or use browser_read, browser_snapshot, or browser_inspect.",
        })
      }
      throw new BrowserProtocolError({
        code: "browser_evaluation_failed",
        message,
        retryable: false,
        pageId: this.options.pageId,
      })
    }
    return result
  }

  private async callOnObject<T = unknown>(
    objectId: string,
    functionDeclaration: string,
    args: unknown[] = [],
    timeoutMs?: number,
  ): Promise<T> {
    const result = await this.options.transport.send<RuntimeResult>("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration,
      arguments: args.map((value) => ({ value })),
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
    })
    if (result.exceptionDetails) {
      throw new BrowserProtocolError({
        code: "browser_action_failed",
        message:
          result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Browser action failed.",
        retryable: false,
        pageId: this.options.pageId,
      })
    }
    return result.result.value as T
  }

  private pushConsole(entry: ConsoleEntry) {
    this.consoleEntries.push({ ...entry, text: entry.text.slice(0, 100_000) })
    if (this.consoleEntries.length > 2_000) this.consoleEntries.splice(0, this.consoleEntries.length - 2_000)
  }

  private redactConsoleEntry(entry: ConsoleEntry | null): ConsoleEntry | null {
    if (!entry) return null
    return {
      ...entry,
      text: redactBrowserText(entry.text),
      ...(entry.url ? { url: redactBrowserURL(entry.url) } : {}),
      ...(entry.stack ? { stack: redactConsoleStack(entry.stack) } : {}),
    }
  }

  private remoteObjectText(object: RemoteObject): string {
    if (object.value !== undefined)
      return typeof object.value === "string" ? object.value : (JSON.stringify(object.value) ?? "")
    return object.description ?? ""
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms))
  }
}

function redactConsoleStack(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]"
  if (typeof value === "string") return redactBrowserText(value).slice(0, 20_000)
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => redactConsoleStack(entry, depth + 1))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 100)
      .map(([key, entry]) => [
        key.slice(0, 1_000),
        key.toLowerCase().includes("url") && typeof entry === "string"
          ? redactBrowserURL(entry)
          : redactConsoleStack(entry, depth + 1),
      ]),
  )
}

function boundedHeaders(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 200)
      .map(([name, header]) => [name.slice(0, 1_000), String(header ?? "").slice(0, 20_000)]),
  )
}

function boundedRecord(value: unknown): Record<string, unknown> | undefined {
  const record = objectRecord(value)
  return record ? Object.fromEntries(Object.entries(record).slice(0, 100)) : undefined
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function keyDefinition(input: string): { key: string; code: string; virtualKeyCode: number; text?: string } {
  const named: Record<string, { code: string; virtualKeyCode: number }> = {
    Enter: { code: "Enter", virtualKeyCode: 13 },
    Tab: { code: "Tab", virtualKeyCode: 9 },
    Escape: { code: "Escape", virtualKeyCode: 27 },
    Backspace: { code: "Backspace", virtualKeyCode: 8 },
    Delete: { code: "Delete", virtualKeyCode: 46 },
    ArrowLeft: { code: "ArrowLeft", virtualKeyCode: 37 },
    ArrowUp: { code: "ArrowUp", virtualKeyCode: 38 },
    ArrowRight: { code: "ArrowRight", virtualKeyCode: 39 },
    ArrowDown: { code: "ArrowDown", virtualKeyCode: 40 },
    Home: { code: "Home", virtualKeyCode: 36 },
    End: { code: "End", virtualKeyCode: 35 },
    PageUp: { code: "PageUp", virtualKeyCode: 33 },
    PageDown: { code: "PageDown", virtualKeyCode: 34 },
    Space: { code: "Space", virtualKeyCode: 32 },
  }
  const special = named[input]
  if (special) return { key: input === "Space" ? " " : input, ...special, ...(input === "Space" ? { text: " " } : {}) }
  if (input.length === 1) {
    const upper = input.toUpperCase()
    const code = /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(input) ? `Digit${input}` : input
    return { key: input, code, virtualKeyCode: upper.charCodeAt(0), text: input }
  }
  return { key: input, code: input, virtualKeyCode: 0 }
}

const actionabilityFunction = `function(action, shouldScroll) {
  if (shouldScroll) this.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const rect = this.getBoundingClientRect();
  const style = getComputedStyle(this);
  const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0;
  const enabled = !this.matches?.(":disabled") && this.getAttribute?.("aria-disabled") !== "true";
  const editable = this.matches?.("input:not([readonly]),textarea:not([readonly]),select,[contenteditable=true]") ?? false;
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  const root = this.getRootNode?.();
  const hit = root?.elementFromPoint?.(x, y) || document.elementFromPoint(x, y);
  const receivesEvents = action === "screenshot" || !hit || hit === this || this.contains?.(hit);
  const obstruction = receivesEvents || !hit ? undefined : {
    tag: hit.tagName?.toLowerCase(),
    role: hit.getAttribute?.("role"),
    name: hit.getAttribute?.("aria-label") || hit.innerText?.trim()?.slice(0, 160) || "",
    id: hit.id || undefined,
    class: typeof hit.className === "string" ? hit.className.slice(0, 200) : undefined,
  };
  return {
    visible,
    enabled,
    editable,
    receivesEvents,
    box: visible ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
    obstruction,
  };
}`

const webVitalsBootstrap = `(() => {
  if (!globalThis.__synergyBrowserResolve) {
    const allElements = (root) => {
      const result = [];
      const visit = (node) => {
        for (const child of node?.children ?? []) {
          result.push(child);
          if (child.shadowRoot) visit(child.shadowRoot);
          visit(child);
        }
      };
      visit(root);
      return result;
    };
    const implicitRole = (el) => {
      const tag = el.tagName?.toLowerCase();
      if (tag === "button") return "button";
      if ((tag === "a" || tag === "area") && el.hasAttribute("href")) return "link";
      if (tag === "select") return el.multiple || el.size > 1 ? "listbox" : "combobox";
      if (tag === "option") return "option";
      if (tag === "textarea") return "textbox";
      if (/^h[1-6]$/.test(tag)) return "heading";
      if (tag === "img" && el.getAttribute("alt") !== "") return "img";
      if (tag === "ul" || tag === "ol") return "list";
      if (tag === "li") return "listitem";
      if (tag === "nav") return "navigation";
      if (tag === "main") return "main";
      if (tag === "aside") return "complementary";
      if (tag === "table") return "table";
      if (tag === "tr") return "row";
      if (tag === "td") return "cell";
      if (tag === "th") return el.getAttribute("scope") === "row" ? "rowheader" : "columnheader";
      if (tag === "progress") return "progressbar";
      if (tag === "input") {
        const type = (el.getAttribute("type") || "text").toLowerCase();
        if (["button", "submit", "reset"].includes(type)) return "button";
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "range") return "slider";
        if (type === "number") return "spinbutton";
        if (type === "hidden") return "";
        return "textbox";
      }
      return "";
    };
    const accessibleName = (el) => {
      const labelledBy = el.getAttribute?.("aria-labelledby");
      if (labelledBy) {
        const root = el.getRootNode?.();
        return labelledBy.split(/\s+/).map((id) => root?.getElementById?.(id)?.textContent ?? document.getElementById(id)?.textContent ?? "").join(" ").trim();
      }
      if (el.getAttribute?.("aria-label")) return el.getAttribute("aria-label").trim();
      if (el.labels?.length) return Array.from(el.labels).map((label) => label.innerText || label.textContent || "").join(" ").trim();
      if (el.getAttribute?.("alt")) return el.getAttribute("alt").trim();
      return (el.innerText || el.textContent || el.getAttribute?.("value") || "").trim();
    };
    const ariaHidden = (el) => {
      let current = el;
      while (current) {
        if (current.getAttribute?.("aria-hidden") === "true") return true;
        current = current.parentElement || current.getRootNode?.()?.host;
      }
      return false;
    };
    globalThis.__synergyBrowserResolve = (locator, root = document.documentElement) => {
      const elements = root === document.documentElement ? [root, ...allElements(root)] : [root, ...allElements(root)];
      const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
      const exact = (actual, wanted, isExact) => isExact ? clean(actual) === clean(wanted) : clean(actual).toLocaleLowerCase().includes(clean(wanted).toLocaleLowerCase());
      switch (locator.kind) {
        case "testId": return elements.filter((el) => el.getAttribute?.("data-testid") === locator.value);
        case "role": return elements.filter((el) => {
          const role = el.getAttribute?.("role")?.trim()?.split(/\s+/)?.[0] || implicitRole(el);
          return !ariaHidden(el) && role === locator.role && (locator.name === undefined || exact(accessibleName(el), locator.name, locator.exact));
        });
        case "label": return elements.filter((el) => {
          const labelable = el.matches?.("button,input:not([type=hidden]),meter,output,progress,select,textarea") || el.isContentEditable;
          const labelled = el.hasAttribute?.("aria-label") || el.hasAttribute?.("aria-labelledby") || (el.labels?.length ?? 0) > 0;
          return labelable && labelled && exact(accessibleName(el), locator.text, locator.exact);
        });
        case "placeholder": return elements.filter((el) => exact(el.getAttribute?.("placeholder") || "", locator.text, locator.exact));
        case "text": {
          const matches = (el) => {
            if (["script", "style", "template", "noscript", "head"].includes(el.tagName?.toLowerCase())) return false;
            const text = el.innerText ?? (el.namespaceURI === "http://www.w3.org/2000/svg" ? el.textContent : "");
            return exact(text, locator.text, locator.exact);
          };
          return elements.filter((el) => matches(el) && !allElements(el).some((descendant) => matches(descendant)));
        }
        case "css": return elements.filter((el) => { try { return el.matches?.(locator.value) } catch (error) { throw new Error("Invalid CSS selector: " + error.message) } });
        case "xpath": {
          const doc = root.ownerDocument || document;
          const iterator = doc.evaluate(locator.value, root, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
          const result = [];
          let node;
          while ((node = iterator.iterateNext())) if (node.nodeType === 1) result.push(node);
          return result;
        }
        default: return [];
      }
    };
  }
  if (!globalThis.__synergyWebVitals) {
    globalThis.__synergyWebVitals = { lcp: null, cls: 0, inp: null, longTasks: 0 };
    try {
      new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries[entries.length - 1];
        if (last) globalThis.__synergyWebVitals.lcp = last.startTime;
      }).observe({ type: "largest-contentful-paint", buffered: true });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) if (!entry.hadRecentInput) globalThis.__synergyWebVitals.cls += entry.value;
      }).observe({ type: "layout-shift", buffered: true });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) globalThis.__synergyWebVitals.inp = Math.max(globalThis.__synergyWebVitals.inp ?? 0, entry.duration);
      }).observe({ type: "event", buffered: true, durationThreshold: 40 });
      new PerformanceObserver((list) => { globalThis.__synergyWebVitals.longTasks += list.getEntries().length; }).observe({ type: "longtask", buffered: true });
    } catch {}
  }
})()`

const networkProfiles: Record<NonNullable<BrowserEmulation["networkProfile"]>, Record<string, unknown>> = {
  online: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
  offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
  "slow-3g": { offline: false, latency: 400, downloadThroughput: 50_000, uploadThroughput: 50_000 },
  "fast-3g": { offline: false, latency: 150, downloadThroughput: 180_000, uploadThroughput: 84_000 },
  "slow-4g": { offline: false, latency: 50, downloadThroughput: 750_000, uploadThroughput: 250_000 },
}
