import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  BROWSER_MAX_DOWNLOAD_BYTES,
  BrowserStagingLeasePool,
  browserDownloadExceedsLimit,
  redactBrowserText,
  redactBrowserURL,
  sanitizeBrowserFilename,
  type BrowserHostDownloadEntry,
  type BrowserHostPageEvent,
} from "@ericsanchezok/synergy-browser"
import { clearBrowserContentPermissions, installBrowserContentPermissions } from "./browser-permissions.js"

const BLOCKED_DOWNLOAD_MIMES = new Set(["application/x-msdownload", "application/x-sh", "application/x-mach-binary"])
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

export interface BrowserHostUploadFile {
  name: string
  mimeType?: string
  data: string
}

interface BrowserHostDiagnosticsOptions {
  pageId: string
  contents: Electron.WebContents
  downloadDir?: string
  emitHostEvent(event: BrowserHostPageEvent): void
}

interface PendingFileChooser {
  backendNodeId?: number
  timer: ReturnType<typeof setTimeout>
}

export class BrowserHostDiagnostics {
  private readonly session: Electron.Session
  private staging = new BrowserStagingLeasePool()
  private pendingDialogs = new Map<string, ReturnType<typeof setTimeout>>()
  private pendingFileChoosers = new Map<string, PendingFileChooser>()
  private pendingDownloads = new Map<string, Electron.DownloadItem>()
  private readonly onDebuggerMessage: (event: Electron.Event, method: string, params: unknown) => void
  private readonly onDownload: (
    event: Electron.Event,
    item: Electron.DownloadItem,
    webContents: Electron.WebContents,
  ) => void

  constructor(private options: BrowserHostDiagnosticsOptions) {
    this.session = options.contents.session
    this.onDebuggerMessage = (_event, method, params) => this.handleDebuggerMessage(method, params)
    this.onDownload = (_event, item, webContents) => {
      if (webContents.id !== this.options.contents.id) return
      item.pause()
      void this.trackDownload(item)
    }
  }

  async start(): Promise<void> {
    const { contents } = this.options
    installBrowserContentPermissions(contents.session)
    contents.session.on("will-download", this.onDownload)
    await this.attachDebugger()
  }

  async dispose(): Promise<void> {
    const { contents } = this.options
    this.session.off("will-download", this.onDownload)
    clearBrowserContentPermissions(this.session)
    for (const timer of this.pendingDialogs.values()) clearTimeout(timer)
    this.pendingDialogs.clear()
    for (const request of this.pendingFileChoosers.values()) clearTimeout(request.timer)
    this.pendingFileChoosers.clear()
    const cleanup: Promise<unknown>[] = []
    for (const item of this.pendingDownloads.values()) {
      item.cancel()
      const savePath = item.getSavePath()
      if (savePath) cleanup.push(fs.rm(savePath, { force: true }))
    }
    this.pendingDownloads.clear()
    cleanup.push(this.staging.dispose())
    const cleanupResults = await Promise.allSettled(cleanup)
    if (!contents.isDestroyed()) {
      contents.debugger.off("message", this.onDebuggerMessage)
      if (contents.debugger.isAttached()) contents.debugger.detach()
    }
    const failures = cleanupResults.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (failures.length) throw new AggregateError(failures, "Browser Host diagnostics did not dispose cleanly.")
  }

  async respondToDialog(requestId: string, accept: boolean, promptText?: string): Promise<void> {
    const timer = this.pendingDialogs.get(requestId)
    if (!timer) throw new Error(`Dialog request ${requestId} is no longer available`)
    clearTimeout(timer)
    this.pendingDialogs.delete(requestId)
    await this.options.contents.debugger.sendCommand("Page.handleJavaScriptDialog", { accept, promptText })
  }

  async respondToFileChooser(requestId: string, files: BrowserHostUploadFile[]): Promise<void> {
    const request = this.pendingFileChoosers.get(requestId)
    if (!request) throw new Error(`File chooser request ${requestId} is no longer available`)
    this.pendingFileChoosers.delete(requestId)
    clearTimeout(request.timer)
    const staged = await this.stageFiles(files)
    try {
      const params: Record<string, unknown> = { files: staged.paths }
      if (request.backendNodeId !== undefined) params.backendNodeId = request.backendNodeId
      await this.options.contents.debugger.sendCommand("DOM.setFileInputFiles", params)
      this.staging.retain(staged.cleanup)
    } catch (error) {
      await staged.cleanup()
      throw error
    }
  }

  async cancelDownload(id: string): Promise<void> {
    const item = this.pendingDownloads.get(id)
    if (!item) throw new Error(`Download ${id} is no longer active.`)
    const savePath = item.getSavePath()
    item.cancel()
    this.pendingDownloads.delete(id)
    if (savePath) await fs.rm(savePath, { force: true })
  }

  async stageFiles(files: BrowserHostUploadFile[]): Promise<{ paths: string[]; cleanup: () => Promise<void> }> {
    if (files.length > 20) throw new Error("A Browser upload can contain at most 20 files.")
    const uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-browser-upload-"))
    await fs.chmod(uploadDir, 0o700)
    const paths: string[] = []
    let totalBytes = 0
    try {
      for (const [index, file] of files.entries()) {
        const data = decodeBase64(file.data)
        totalBytes += data.byteLength
        if (data.byteLength > 25 * 1024 * 1024 || totalBytes > 50 * 1024 * 1024) {
          throw new Error("Browser upload exceeds the 25 MB per-file or 50 MB request limit.")
        }
        const name = safeBasename(file.name, `upload-${index}`)
        const filepath = path.join(uploadDir, `${index}-${name}`)
        await fs.writeFile(filepath, data, { flag: "wx", mode: 0o600 })
        paths.push(filepath)
      }
      return { paths, cleanup: () => fs.rm(uploadDir, { recursive: true, force: true }) }
    } catch (error) {
      await fs.rm(uploadDir, { recursive: true, force: true })
      throw error
    }
  }

  private async attachDebugger(): Promise<void> {
    const { contents } = this.options
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3")
    contents.debugger.on("message", this.onDebuggerMessage)
    await Promise.all([
      contents.debugger.sendCommand("Page.enable"),
      contents.debugger.sendCommand("DOM.enable"),
      contents.debugger.sendCommand("Page.setInterceptFileChooserDialog", { enabled: true }),
    ])
  }

  private handleDebuggerMessage(method: string, params: unknown): void {
    if (method === "Page.javascriptDialogOpening") this.handleJavaScriptDialog(params)
    if (method === "Page.fileChooserOpened") this.handleFileChooser(params)
  }

  private handleJavaScriptDialog(params: unknown): void {
    const data = record(params)
    const requestId = `dialog-${crypto.randomUUID()}`
    const timer = setTimeout(() => {
      if (!this.pendingDialogs.delete(requestId)) return
      void this.options.contents.debugger
        .sendCommand("Page.handleJavaScriptDialog", { accept: false })
        .catch((error) => this.emitFailure("Timed-out Browser dialog could not be dismissed", error))
    }, 30_000)
    timer.unref?.()
    this.pendingDialogs.set(requestId, timer)
    this.options.emitHostEvent({
      type: "dialog.opened",
      pageId: this.options.pageId,
      requestId,
      dialogType: String(data.type ?? "alert").slice(0, 1_000),
      message: String(data.message ?? "").slice(0, 100_000),
      defaultValue: typeof data.defaultPrompt === "string" ? data.defaultPrompt.slice(0, 100_000) : undefined,
    })
  }

  private handleFileChooser(params: unknown): void {
    const data = record(params)
    const requestId = `filechooser-${crypto.randomUUID()}`
    const backendNodeId = typeof data.backendNodeId === "number" ? data.backendNodeId : undefined
    const timer = setTimeout(() => {
      if (!this.pendingFileChoosers.delete(requestId)) return
      void this.options.contents.debugger
        .sendCommand("DOM.setFileInputFiles", {
          files: [],
          ...(backendNodeId !== undefined ? { backendNodeId } : {}),
        })
        .catch((error) => this.emitFailure("Timed-out Browser file chooser could not be dismissed", error))
    }, 30_000)
    timer.unref?.()
    this.pendingFileChoosers.set(requestId, {
      backendNodeId,
      timer,
    })
    this.options.emitHostEvent({
      type: "filechooser.request",
      pageId: this.options.pageId,
      requestId,
      multiple: data.mode === "selectMultiple",
      accept: [],
    })
  }

  private async trackDownload(item: Electron.DownloadItem): Promise<void> {
    const id = `download-${crypto.randomUUID()}`
    const fileName = safeBasename(item.getFilename(), "download")
    const mimeType = (item.getMimeType() || "application/octet-stream").slice(0, 256)
    const entry: BrowserHostDownloadEntry = {
      id,
      url: redactBrowserURL(item.getURL()).slice(0, 20_000),
      fileName,
      mimeType,
      state: "in_progress",
      totalBytes: browserByteCount(item.getTotalBytes()),
      receivedBytes: browserByteCount(item.getReceivedBytes()),
      timestamp: Date.now(),
    }
    if (isDangerousDownload(mimeType, fileName)) {
      entry.state = "blocked"
      entry.warning = `Download blocked by browser safety policy: ${fileName}`
      item.cancel()
      this.emitDownload(entry)
      return
    }
    if (browserDownloadExceedsLimit(entry.totalBytes)) {
      entry.state = "blocked"
      entry.warning = `Download exceeds the ${BROWSER_MAX_DOWNLOAD_BYTES / (1024 * 1024)} MiB Browser limit.`
      item.cancel()
      this.emitDownload(entry)
      return
    }

    try {
      const root = await this.downloadRoot()
      const target = path.join(root, `${id}-${fileName}`)
      if (!target.startsWith(`${root}${path.sep}`)) throw new Error("Managed download escaped its owner directory.")
      const marker = await fs.open(target, "wx", 0o600)
      await marker.close()
      await fs.unlink(target)
      item.setSavePath(target)
      entry.path = target
      this.pendingDownloads.set(id, item)
      this.emitDownload(entry)
      let oversized = false
      item.on("updated", (_event, state) => {
        if (oversized) return
        entry.state = state === "interrupted" ? "interrupted" : "in_progress"
        entry.totalBytes = browserByteCount(item.getTotalBytes())
        entry.receivedBytes = browserByteCount(item.getReceivedBytes())
        if (browserDownloadExceedsLimit(entry.totalBytes, entry.receivedBytes)) {
          oversized = true
          entry.state = "blocked"
          entry.warning = `Download exceeds the ${BROWSER_MAX_DOWNLOAD_BYTES / (1024 * 1024)} MiB Browser limit.`
          item.cancel()
        }
        this.emitDownload(entry)
      })
      item.on("done", (_event, state) => {
        this.pendingDownloads.delete(id)
        entry.state = oversized ? "blocked" : state
        entry.totalBytes = browserByteCount(item.getTotalBytes())
        entry.receivedBytes = browserByteCount(item.getReceivedBytes())
        if (oversized) {
          void fs.rm(target, { force: true }).catch(() => {
            entry.warning = "The oversized Browser download could not be removed from managed storage."
            this.emitDownload(entry)
          })
        }
        this.emitDownload(entry)
      })
      item.resume()
    } catch (error) {
      item.cancel()
      entry.state = "interrupted"
      entry.warning = (error instanceof Error ? error.message : String(error)).slice(0, 100_000)
      this.emitDownload(entry)
    }
  }

  private async downloadRoot(): Promise<string> {
    if (!this.options.downloadDir) throw new Error("Managed Browser download storage is unavailable.")
    const stat = await fs.lstat(this.options.downloadDir)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Managed Browser download storage is unsafe.")
    return fs.realpath(this.options.downloadDir)
  }

  private emitDownload(entry: BrowserHostDownloadEntry): void {
    this.options.emitHostEvent({ type: "download.updated", pageId: this.options.pageId, entry })
  }

  private emitFailure(message: string, error: unknown): void {
    this.options.emitHostEvent({
      type: "page.error",
      pageId: this.options.pageId,
      message: redactBrowserText(`${message}: ${error instanceof Error ? error.message : String(error)}`).slice(
        0,
        100_000,
      ),
    })
  }
}

function browserByteCount(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0
}

function safeBasename(value: string, fallback: string): string {
  return sanitizeBrowserFilename(value, fallback)
}

function decodeBase64(value: string): Buffer {
  const normalized = value.replace(/\s/g, "")
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
    throw new Error("Browser upload contains invalid base64 data.")
  }
  return Buffer.from(normalized, "base64")
}

function isDangerousDownload(mimeType: string, filename: string): boolean {
  const mime = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? ""
  return BLOCKED_DOWNLOAD_MIMES.has(mime) || BLOCKED_DOWNLOAD_EXTENSIONS.has(path.extname(filename).toLowerCase())
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}
