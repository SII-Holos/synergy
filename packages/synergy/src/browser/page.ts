import fs from "node:fs/promises"
import path from "node:path"
import type { Dialog, Download, FileChooser, Page, Response, Route } from "playwright"
import {
  BROWSER_MAX_DOWNLOAD_BYTES,
  BrowserNavigationPolicy,
  BrowserProtocolError,
  BrowserStagingLeasePool,
  CdpPageController,
  browserDownloadExceedsLimit,
  redactBrowserURL,
  sanitizeBrowserFilename,
  type BrowserBackendCommand,
  type BrowserBackendResult,
  type BrowserHostDownloadEntry,
} from "@ericsanchezok/synergy-browser"
import { BrowserDownloads } from "./downloads.js"
import type { BrowserOwner } from "./owner.js"
import { PlaywrightCdpTransport } from "./playwright-cdp-transport.js"
import { BrowserPolicy } from "./policy.js"
import { BrowserStorage } from "./storage.js"

export interface BrowserFileChooserRequest {
  requestId: string
  multiple: boolean
  accept: string[]
}

export interface BrowserDialogRequest {
  requestId: string
  type: string
  message: string
  defaultValue?: string
}

export interface BrowserPageEventHandlers {
  onLoading?: (page: BrowserPageBackend, url: string) => void
  onLoaded?: (page: BrowserPageBackend) => void
  onUpdated?: (page: BrowserPageBackend) => void
  onError?: (page: BrowserPageBackend, message: string) => void
  onCrashed?: (page: BrowserPageBackend, message: string) => void
  onDownload?: (page: BrowserPageBackend, entry: BrowserHostDownloadEntry) => void
  onFileChooser?: (page: BrowserPageBackend, request: BrowserFileChooserRequest) => void
  onDialog?: (page: BrowserPageBackend, request: BrowserDialogRequest) => void
}

export interface BrowserPageBackend {
  readonly id: string
  readonly backend: "headless" | "host"
  url: string
  title: string
  loading: boolean
  lastActiveAt: number | null
  isAlive(): boolean
  execute(command: BrowserBackendCommand): Promise<BrowserBackendResult>
  close(): Promise<void>
}

export class PlaywrightBrowserPage implements BrowserPageBackend {
  readonly id: string
  readonly backend = "headless" as const
  url = "about:blank"
  title = ""
  loading = false
  lastActiveAt: number | null = null

  private events: BrowserPageEventHandlers
  private pendingFileChoosers = new Map<string, FileChooser>()
  private pendingDownloads = new Map<string, Download>()
  private cancelledDownloads = new Set<string>()
  private fileChooserTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private responseMimeTypes = new Map<string, string>()
  private transport: PlaywrightCdpTransport
  private controller: CdpPageController
  private listeners: Array<() => void> = []
  private crashed = false
  private navigation: BrowserNavigationPolicy
  private navigationBlocked: { url: string; reason: string } | null = null
  private routingReady: Promise<void>
  private clipboardText = ""
  private staging = new BrowserStagingLeasePool()
  private releaseOwner?: () => Promise<void>

  constructor(
    private page: Page,
    private owner: BrowserOwner.Info,
    options: { id?: string; events?: BrowserPageEventHandlers; releaseOwner?: () => Promise<void> } = {},
  ) {
    this.id = options.id ?? crypto.randomUUID()
    this.events = options.events ?? {}
    this.releaseOwner = options.releaseOwner
    this.navigation = new BrowserNavigationPolicy({
      allowUserNavigation: (url) => BrowserPolicy.hardCheckNavigation(url, this.owner.directory).decision === "allow",
    })
    this.routingReady = this.page.route("**/*", (route) => this.guardNavigation(route)).then(() => undefined)
    this.transport = new PlaywrightCdpTransport(page)
    this.controller = new CdpPageController({
      pageId: this.id,
      transport: this.transport,
      clipboard: {
        readText: () => this.clipboardText,
        writeText: (text) => {
          this.clipboardText = text
        },
      },
      stageFiles: (files) => this.stageFiles(files),
    })
    this.installPageEvents()
  }

  async execute(command: BrowserBackendCommand): Promise<BrowserBackendResult> {
    await this.routingReady
    if (command.type === "filechooser.select") {
      await this.selectFiles(command.requestId, command.files)
      return { type: "void" }
    }
    if (command.type === "download.cancel") {
      const download = this.pendingDownloads.get(command.id)
      if (!download) throw new Error(`Download ${command.id} is no longer active.`)
      this.cancelledDownloads.add(command.id)
      await download.cancel()
      return { type: "void" }
    }
    if (command.type === "navigate") this.navigation.begin(command.url, command.source)
    if (command.type === "checkpoint" && command.action === "restore") {
      if (!command.checkpoint) throw new Error("checkpoint is required for restore.")
      this.navigation.begin(command.checkpoint.url, "agent")
    }
    let result: BrowserBackendResult
    try {
      result = await this.controller.execute(command)
    } catch (error) {
      if (this.navigationBlocked) this.throwNavigationBlocked()
      throw error
    }
    await Promise.resolve()
    if (this.navigationBlocked) this.throwNavigationBlocked()
    this.sync(result)
    return result
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled([
      this.controller.dispose(),
      this.transport.dispose(),
      this.staging.dispose(),
    ])
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    for (const dispose of this.listeners.splice(0)) {
      try {
        dispose()
      } catch (error) {
        failures.push(error)
      }
    }
    this.pendingFileChoosers.clear()
    this.pendingDownloads.clear()
    this.cancelledDownloads.clear()
    for (const timer of this.fileChooserTimers.values()) clearTimeout(timer)
    this.fileChooserTimers.clear()
    this.responseMimeTypes.clear()
    try {
      await this.page.close()
    } catch (error) {
      if (!this.page.isClosed()) failures.push(error)
    }
    try {
      await this.releaseOwner?.()
    } catch (error) {
      failures.push(error)
    }
    if (failures.length) throw new AggregateError(failures, "Browser page resources could not be fully released.")
  }

  isAlive(): boolean {
    return !this.crashed && !this.page.isClosed()
  }

  private sync(result: BrowserBackendResult): void {
    if (result.type !== "page" && result.type !== "navigation") return
    this.url = result.page.url
    this.title = result.page.title
    this.loading = result.page.isLoading
    this.lastActiveAt = result.page.lastActiveAt
  }

  private listen(event: string, listener: (...args: never[]) => void): void {
    const page = this.page as unknown as {
      on(name: string, callback: (...args: unknown[]) => unknown): void
      off(name: string, callback: (...args: unknown[]) => unknown): void
    }
    const callback = listener as unknown as (...args: unknown[]) => unknown
    page.on(event, callback)
    this.listeners.push(() => page.off(event, callback))
  }

  private installPageEvents(): void {
    this.listen("load", () => {
      void this.refresh().then(() => {
        this.loading = false
        this.events.onLoaded?.(this)
      })
    })
    this.listen("framenavigated", ((frame: { parentFrame(): unknown; url(): string }) => {
      if (frame.parentFrame()) return
      this.url = frame.url().slice(0, 20_000)
      this.navigation.noteCommitted(this.url)
      this.loading = true
      this.events.onLoading?.(this, this.url)
      void this.refresh()
    }) as never)
    this.listen("crash", () => {
      this.crashed = true
      this.loading = false
      this.events.onCrashed?.(this, "Browser page crashed")
    })
    this.listen("pageerror", ((error: Error) => this.events.onError?.(this, error.message)) as never)
    this.listen("response", ((response: Response) => {
      const mimeType = response.headers()["content-type"]
      if (!mimeType) return
      this.responseMimeTypes.set(response.url(), mimeType)
      if (this.responseMimeTypes.size > 200) {
        const oldest = this.responseMimeTypes.keys().next().value
        if (oldest) this.responseMimeTypes.delete(oldest)
      }
    }) as never)
    this.listen("download", ((download: Download) => void this.trackDownload(download)) as never)
    this.listen("filechooser", ((chooser: FileChooser) => void this.trackFileChooser(chooser)) as never)
    this.listen("dialog", ((dialog: Dialog) => this.trackDialog(dialog)) as never)
  }

  private async guardNavigation(route: Route): Promise<void> {
    const request = route.request()
    if (!request.isNavigationRequest() || request.frame() !== this.page.mainFrame()) {
      await route.continue()
      return
    }
    const decision = this.navigation.decide(request.url())
    if (decision.allowed) {
      await route.continue()
      return
    }
    this.navigationBlocked = {
      url: request.url(),
      reason: decision.reason ?? "Browser navigation policy denied the request.",
    }
    await route.abort("blockedbyclient")
  }

  private throwNavigationBlocked(): never {
    const blocked = this.navigationBlocked!
    this.navigationBlocked = null
    throw new BrowserProtocolError({
      code: "browser_navigation_denied",
      message: blocked.reason,
      retryable: false,
      pageId: this.id,
      url: blocked.url,
    })
  }

  private async refresh(): Promise<void> {
    this.url = this.page.url().slice(0, 20_000)
    this.lastActiveAt = Date.now()
    this.title = (await this.page.title().catch(() => "")).slice(0, 20_000)
  }

  private async trackDownload(download: Download): Promise<void> {
    const id = `download-${crypto.randomUUID()}`
    const fileName = sanitizeBrowserFilename(download.suggestedFilename(), "download")
    const rawURL = download.url()
    const url = redactBrowserURL(rawURL).slice(0, 20_000)
    const mimeType = (this.responseMimeTypes.get(rawURL) ?? "application/octet-stream").slice(0, 256)
    const entry: BrowserHostDownloadEntry = {
      id,
      url,
      fileName,
      mimeType,
      state: "in_progress",
      totalBytes: 0,
      receivedBytes: 0,
      timestamp: Date.now(),
    }
    this.pendingDownloads.set(id, download)
    const tracked = BrowserDownloads.add(this.owner, {
      id,
      pageID: this.id,
      url,
      suggestedFilename: fileName,
      mimeType,
      state: "pending",
      createdAt: entry.timestamp,
    })
    if (!tracked) {
      entry.state = "blocked"
      entry.warning = "Download blocked because this Browser owner reached the 10,000-record limit."
      try {
        await download.cancel()
      } catch {
        entry.warning += " The backend could not confirm cancellation."
      }
      this.pendingDownloads.delete(id)
      this.events.onDownload?.(this, entry)
      return
    }
    if (BrowserPolicy.isDangerousDownload({ mimeType, filename: fileName })) {
      entry.state = "blocked"
      entry.warning = `Download blocked by browser safety policy: ${fileName}`
      BrowserDownloads.update(this.owner, id, { state: "blocked", mimeType })
      try {
        await download.cancel()
      } catch {
        entry.warning += " The backend could not confirm cancellation."
      }
      this.pendingDownloads.delete(id)
      this.events.onDownload?.(this, entry)
      return
    }

    this.events.onDownload?.(this, entry)
    try {
      const downloadPath = await BrowserDownloads.managedPath(this.owner, id, fileName)
      const source = await download.path()
      if (!source) throw new Error("Browser download did not produce a managed source file.")
      const sourceStat = await fs.stat(source)
      if (browserDownloadExceedsLimit(sourceStat.size)) {
        entry.state = "blocked"
        entry.warning = `Download exceeds the ${BROWSER_MAX_DOWNLOAD_BYTES / (1024 * 1024)} MiB Browser limit.`
        BrowserDownloads.update(this.owner, id, { state: "blocked" })
        await download.cancel()
        this.events.onDownload?.(this, entry)
        return
      }
      await fs.copyFile(source, downloadPath, fs.constants.COPYFILE_EXCL)
      const stat = await fs.stat(downloadPath)
      entry.state = "completed"
      entry.path = downloadPath
      entry.totalBytes = stat.size
      entry.receivedBytes = stat.size
      BrowserDownloads.update(this.owner, id, { state: "completed", path: downloadPath, size: stat.size })
    } catch {
      const cancelled = this.cancelledDownloads.delete(id)
      if (entry.state !== "blocked") {
        entry.state = cancelled ? "cancelled" : "interrupted"
        entry.warning = cancelled ? undefined : "The Browser download did not complete."
        BrowserDownloads.update(this.owner, id, { state: cancelled ? "cancelled" : "failed" })
      }
    } finally {
      this.pendingDownloads.delete(id)
      this.cancelledDownloads.delete(id)
    }
    this.events.onDownload?.(this, entry)
  }

  private async trackFileChooser(chooser: FileChooser): Promise<void> {
    const requestId = `filechooser-${crypto.randomUUID()}`
    this.pendingFileChoosers.set(requestId, chooser)
    const timer = setTimeout(() => {
      this.pendingFileChoosers.delete(requestId)
      this.fileChooserTimers.delete(requestId)
      void chooser
        .setFiles([])
        .catch(() => this.events.onError?.(this, "Timed-out file chooser could not be dismissed."))
    }, 30_000)
    timer.unref?.()
    this.fileChooserTimers.set(requestId, timer)
    const metadata = await chooser
      .element()
      .evaluate((input) => {
        const element = input as HTMLInputElement
        return {
          multiple: element.multiple,
          accept: element.accept
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
            .slice(0, 100)
            .map((value) => value.slice(0, 1_000)),
        }
      })
      .catch(() => ({ multiple: false, accept: [] as string[] }))
    this.events.onFileChooser?.(this, { requestId, ...metadata })
  }

  private trackDialog(dialog: Dialog): void {
    const requestId = `dialog-${crypto.randomUUID()}`
    this.events.onDialog?.(this, {
      requestId,
      type: dialog.type().slice(0, 1_000),
      message: dialog.message().slice(0, 100_000),
      defaultValue: dialog.defaultValue().slice(0, 100_000),
    })
    const timer = setTimeout(
      () => dialog.dismiss().catch(() => this.events.onError?.(this, "Timed-out dialog could not be dismissed.")),
      30_000,
    )
    timer.unref?.()
  }

  private async selectFiles(
    requestId: string,
    files: Array<{ name: string; mimeType: string; dataBase64: string }>,
  ): Promise<void> {
    const chooser = this.pendingFileChoosers.get(requestId)
    if (!chooser) throw new Error(`File chooser request ${requestId} is no longer available.`)
    this.pendingFileChoosers.delete(requestId)
    const timer = this.fileChooserTimers.get(requestId)
    if (timer) clearTimeout(timer)
    this.fileChooserTimers.delete(requestId)
    if (files.length === 0) {
      await chooser.setFiles([])
      return
    }
    const staged = await this.stageFiles(files)
    try {
      await chooser.setFiles(staged.paths)
      this.staging.retain(staged.cleanup)
    } catch (error) {
      await staged.cleanup()
      throw error
    }
  }

  private async stageFiles(
    files: Array<{ name: string; mimeType: string; dataBase64: string }>,
  ): Promise<{ paths: string[]; cleanup: () => Promise<void> }> {
    const uploadRoot = BrowserStorage.uploadsDir(this.owner)
    await fs.mkdir(uploadRoot, { recursive: true, mode: 0o700 })
    const rootInfo = await fs.lstat(uploadRoot)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Browser upload storage is unsafe.")
    const requestDir = await fs.mkdtemp(path.join(await fs.realpath(uploadRoot), "request-"))
    await fs.chmod(requestDir, 0o700)
    const paths: string[] = []
    let totalBytes = 0
    try {
      for (const [index, file] of files.entries()) {
        const encoded = file.dataBase64.replace(/\s/g, "")
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
          throw new Error("Browser upload contains invalid base64 data.")
        }
        const data = Buffer.from(encoded, "base64")
        totalBytes += data.byteLength
        if (data.byteLength > 25 * 1024 * 1024 || totalBytes > 50 * 1024 * 1024) {
          throw new Error("Browser upload exceeds the 25 MB per-file or 50 MB request limit.")
        }
        const basename = sanitizeBrowserFilename(file.name, `upload-${index}`)
        const filepath = path.join(requestDir, `${index}-${basename}`)
        await fs.writeFile(filepath, data, { flag: "wx", mode: 0o600 })
        paths.push(filepath)
      }
      return { paths, cleanup: () => fs.rm(requestDir, { recursive: true, force: true }) }
    } catch (error) {
      await fs.rm(requestDir, { recursive: true, force: true })
      throw error
    }
  }
}
