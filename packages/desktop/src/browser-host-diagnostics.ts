import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const MAX_BUFFER_SIZE = 200

const SENSITIVE_HEADERS = new Set(["cookie", "set-cookie", "authorization", "x-api-key", "www-authenticate"])
const BLOCKED_DOWNLOAD_MIMES = new Set([
  "application/octet-stream",
  "application/x-msdownload",
  "application/x-sh",
  "application/x-mach-binary",
])
const BLOCKED_DOWNLOAD_EXTENSIONS = new Set([
  ".app",
  ".bat",
  ".cmd",
  ".com",
  ".dmg",
  ".exe",
  ".msi",
  ".pkg",
  ".ps1",
  ".scr",
  ".sh",
  ".vbs",
])

export interface BrowserHostConsoleEntry {
  level: string
  text: string
  timestamp: number
  stackTrace?: string
}

export interface BrowserHostNetworkRequest {
  requestId: string
  url: string
  method: string
  status?: number
  mimeType?: string
  responseHeaders?: Record<string, string>
  type: string
  timestamp: number
}

export interface BrowserHostPageAsset {
  id: string
  tabID: string
  url: string
  type: "image" | "script" | "stylesheet" | "font" | "media" | "document" | "other"
  mimeType?: string
  status?: number
  size?: number
  initiator?: string
}

export interface BrowserHostUploadFile {
  name: string
  mimeType?: string
  data: string
}

const MIME_TO_ASSET_TYPE: [RegExp, BrowserHostPageAsset["type"]][] = [
  [/^image\//, "image"],
  [/^text\/javascript$/, "script"],
  [/^application\/javascript$/, "script"],
  [/^application\/x-javascript$/, "script"],
  [/^text\/css$/, "stylesheet"],
  [/^font\//, "font"],
  [/^application\/font-/, "font"],
  [/^video\//, "media"],
  [/^audio\//, "media"],
  [/^text\/html$/, "document"],
  [/^application\/xhtml\+xml$/, "document"],
  [/^application\/pdf$/, "document"],
]

type BrowserHostDownloadState = "in_progress" | "completed" | "cancelled" | "interrupted" | "blocked"

interface BrowserHostDownloadEntry {
  id: string
  url: string
  fileName: string
  mimeType: string
  state: BrowserHostDownloadState
  totalBytes: number
  receivedBytes: number
  timestamp: number
  path?: string
  warning?: string
}

interface BrowserHostDiagnosticsOptions {
  tabId: string
  contents: Electron.WebContents
  emitHostEvent(event: Record<string, unknown>): void
}

interface PendingFileChooser {
  backendNodeId?: number
}

export class BrowserHostDiagnostics {
  private consoleBuffer: BrowserHostConsoleEntry[] = []
  private networkBuffer: BrowserHostNetworkRequest[] = []
  private pendingDialogs = new Map<string, ReturnType<typeof setTimeout>>()
  private pendingFileChoosers = new Map<string, PendingFileChooser>()
  private readonly onConsoleMessage: (...args: unknown[]) => void
  private readonly onDebuggerMessage: (event: Electron.Event, method: string, params: any) => void
  private readonly onDownload: (
    event: Electron.Event,
    item: Electron.DownloadItem,
    webContents: Electron.WebContents,
  ) => void

  constructor(private options: BrowserHostDiagnosticsOptions) {
    this.onConsoleMessage = (_event, level, message) => {
      this.consoleBuffer.push({ level: String(level), text: String(message), timestamp: Date.now() })
      this.trimBuffers()
    }
    this.onDebuggerMessage = (_event, method, params) => this.handleDebuggerMessage(method, params)
    this.onDownload = (_event, item, webContents) => {
      if (webContents.id !== this.options.contents.id) return
      this.trackDownload(item)
    }
  }

  start(): void {
    const { contents } = this.options
    contents.on("console-message", this.onConsoleMessage as any)
    this.installNetworkHooks()
    this.installPermissions()
    contents.session.on("will-download", this.onDownload)
    this.attachDebugger()
  }

  dispose(): void {
    const { contents } = this.options
    contents.off("console-message", this.onConsoleMessage as any)
    contents.session.off("will-download", this.onDownload)
    contents.session.webRequest.onBeforeRequest(null)
    contents.session.webRequest.onCompleted(null)
    contents.session.webRequest.onErrorOccurred(null)
    contents.session.setPermissionRequestHandler(null)
    if (contents.debugger.isAttached()) {
      contents.debugger.off("message", this.onDebuggerMessage)
      contents.debugger.detach()
    }
  }

  consoleEntries(maxEntries = 50): BrowserHostConsoleEntry[] {
    return this.consoleBuffer.slice(-maxEntries)
  }

  networkRequests(maxEntries = 100): BrowserHostNetworkRequest[] {
    return this.networkBuffer.slice(-maxEntries)
  }

  pageAssets(tabId = this.options.tabId, maxEntries = 100): BrowserHostPageAsset[] {
    return this.networkRequests(maxEntries).map((request) => ({
      id: request.requestId,
      tabID: tabId,
      url: request.url,
      type: classifyAssetByMime(request.mimeType ?? ""),
      mimeType: request.mimeType,
      status: request.status,
      size: undefined,
      initiator: undefined,
    }))
  }

  clear(): void {
    this.consoleBuffer = []
    this.networkBuffer = []
  }

  async respondToDialog(requestId: string, accept: boolean, promptText?: string): Promise<void> {
    const timer = this.pendingDialogs.get(requestId)
    if (!timer) throw new Error(`Dialog request ${requestId} is no longer available`)
    clearTimeout(timer)
    this.pendingDialogs.delete(requestId)
    await this.options.contents.debugger.sendCommand("Page.handleJavaScriptDialog", {
      accept,
      promptText,
    })
  }

  async respondToFileChooser(requestId: string, files: BrowserHostUploadFile[]): Promise<void> {
    const request = this.pendingFileChoosers.get(requestId)
    if (!request) throw new Error(`File chooser request ${requestId} is no longer available`)
    this.pendingFileChoosers.delete(requestId)

    const paths = await this.writeUploadFiles(requestId, files)
    const params: Record<string, unknown> = { files: paths }
    if (request.backendNodeId !== undefined) params.backendNodeId = request.backendNodeId
    await this.options.contents.debugger.sendCommand("DOM.setFileInputFiles", params)
  }

  private installNetworkHooks(): void {
    const { contents } = this.options
    const filter = { urls: ["<all_urls>"] }
    contents.session.webRequest.onBeforeRequest(filter, (details, callback) => {
      if (details.webContentsId === contents.id) {
        const requestId = String(details.id)
        this.networkBuffer.push({
          requestId,
          url: details.url,
          method: details.method,
          type: details.resourceType,
          timestamp: Date.now(),
        })
        this.trimBuffers()
      }
      callback({})
    })
    contents.session.webRequest.onCompleted(filter, (details) => {
      if (details.webContentsId !== contents.id) return
      const request = this.networkBuffer.find((item) => item.requestId === String(details.id))
      if (!request) return
      request.status = details.statusCode
      request.mimeType = firstHeader(details.responseHeaders, "content-type")
      request.responseHeaders = sanitizeHeaders(details.responseHeaders)
    })
    contents.session.webRequest.onErrorOccurred(filter, (details) => {
      if (details.webContentsId !== contents.id) return
      const request = this.networkBuffer.find((item) => item.requestId === String(details.id))
      if (!request) return
      request.status = 0
    })
  }

  private installPermissions(): void {
    const { contents } = this.options
    contents.session.setPermissionRequestHandler((webContents, permission, callback) => {
      if (permission === "display-capture") {
        callback(true)
        return
      }
      if (webContents.id !== contents.id) {
        callback(false)
        return
      }
      callback(allowBrowserPermission(permission))
    })
  }

  private attachDebugger(): void {
    const { contents } = this.options
    if (!contents.debugger.isAttached()) {
      try {
        contents.debugger.attach("1.3")
      } catch {
        return
      }
    }
    contents.debugger.on("message", this.onDebuggerMessage)
    void contents.debugger.sendCommand("Page.enable").catch(() => {})
    void contents.debugger.sendCommand("DOM.enable").catch(() => {})
    void contents.debugger.sendCommand("Page.setInterceptFileChooserDialog", { enabled: true }).catch(() => {})
  }

  private handleDebuggerMessage(method: string, params: any): void {
    if (method === "Page.javascriptDialogOpening") {
      this.handleJavaScriptDialog(params)
      return
    }
    if (method === "Page.fileChooserOpened") {
      this.handleFileChooser(params)
    }
  }

  private handleJavaScriptDialog(params: any): void {
    const requestId = `dialog-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const timer = setTimeout(() => {
      if (!this.pendingDialogs.delete(requestId)) return
      void this.options.contents.debugger.sendCommand("Page.handleJavaScriptDialog", { accept: false }).catch(() => {})
    }, 30_000)
    this.pendingDialogs.set(requestId, timer)
    this.options.emitHostEvent({
      type: "dialog.opened",
      tabId: this.options.tabId,
      requestId,
      dialogType: String(params?.type ?? "alert"),
      message: String(params?.message ?? ""),
      defaultValue: typeof params?.defaultPrompt === "string" ? params.defaultPrompt : undefined,
    })
  }

  private handleFileChooser(params: any): void {
    const requestId = `fc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    this.pendingFileChoosers.set(requestId, {
      backendNodeId: typeof params?.backendNodeId === "number" ? params.backendNodeId : undefined,
    })
    this.options.emitHostEvent({
      type: "filechooser.request",
      tabId: this.options.tabId,
      requestId,
      multiple: params?.mode === "selectMultiple",
      accept: [],
    })
  }

  private trackDownload(item: Electron.DownloadItem): void {
    const id = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const entry: BrowserHostDownloadEntry = {
      id,
      url: item.getURL(),
      fileName: item.getFilename(),
      mimeType: item.getMimeType() || "unknown/unknown",
      state: "in_progress",
      totalBytes: item.getTotalBytes(),
      receivedBytes: item.getReceivedBytes(),
      timestamp: Date.now(),
      path: item.getSavePath() || undefined,
      warning: undefined as string | undefined,
    }

    if (isDangerousDownload(entry.mimeType, entry.fileName)) {
      entry.state = "blocked"
      entry.warning = `Download blocked by browser safety policy: ${entry.fileName}`
      item.cancel()
      this.emitDownload(entry)
      return
    }

    this.emitDownload(entry)
    item.on("updated", (_event, state) => {
      entry.state = state === "interrupted" ? "interrupted" : "in_progress"
      entry.totalBytes = item.getTotalBytes()
      entry.receivedBytes = item.getReceivedBytes()
      entry.path = item.getSavePath() || undefined
      this.emitDownload(entry)
    })
    item.on("done", (_event, state) => {
      entry.state = state
      entry.totalBytes = item.getTotalBytes()
      entry.receivedBytes = item.getReceivedBytes()
      entry.path = item.getSavePath() || undefined
      this.emitDownload(entry)
    })
  }

  private emitDownload(entry: BrowserHostDownloadEntry): void {
    this.options.emitHostEvent({
      type: "downloads.updated",
      tabId: this.options.tabId,
      entry,
    })
  }

  private async writeUploadFiles(requestId: string, files: BrowserHostUploadFile[]): Promise<string[]> {
    const uploadDir = path.join(os.tmpdir(), "synergy-browser-uploads", this.options.tabId, requestId)
    await fs.mkdir(uploadDir, { recursive: true })
    const paths: string[] = []
    for (const [index, file] of files.entries()) {
      const safeName = path.basename(file.name || `upload-${index}`)
      const filepath = path.join(uploadDir, safeName)
      await fs.writeFile(filepath, Buffer.from(file.data, "base64"))
      paths.push(filepath)
    }
    return paths
  }

  private trimBuffers(): void {
    if (this.consoleBuffer.length > MAX_BUFFER_SIZE) {
      this.consoleBuffer.splice(0, this.consoleBuffer.length - MAX_BUFFER_SIZE)
    }
    if (this.networkBuffer.length > MAX_BUFFER_SIZE) {
      this.networkBuffer.splice(0, this.networkBuffer.length - MAX_BUFFER_SIZE)
    }
  }
}

function allowBrowserPermission(permission: string): boolean {
  return permission === "clipboard-read" || permission === "clipboard-sanitized-write" || permission === "fullscreen"
}

function isDangerousDownload(mimeType?: string, filename?: string): boolean {
  const normalizedMime = mimeType?.split(";")[0]?.trim().toLowerCase()
  if (normalizedMime && BLOCKED_DOWNLOAD_MIMES.has(normalizedMime)) return true
  const ext = path.extname(filename?.trim().toLowerCase() ?? "")
  return Boolean(ext && BLOCKED_DOWNLOAD_EXTENSIONS.has(ext))
}

function classifyAssetByMime(mimeType: string): BrowserHostPageAsset["type"] {
  const normalized = mimeType.trim().split(";")[0]?.toLowerCase() ?? ""
  if (!normalized) return "other"
  for (const [pattern, type] of MIME_TO_ASSET_TYPE) {
    if (pattern.test(normalized)) return type
  }
  return "other"
}

function firstHeader(headers: Record<string, string[]> | undefined, name: string): string | undefined {
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)
  return entry?.[1]?.[0]
}

function sanitizeHeaders(headers: Record<string, string[]> | undefined): Record<string, string> {
  const sanitized: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (!SENSITIVE_HEADERS.has(key.toLowerCase())) sanitized[key] = value.join(", ")
  }
  return sanitized
}
