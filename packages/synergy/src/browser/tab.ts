import fs from "fs/promises"
import path from "path"
import type { Dialog, Download, FileChooser, Page } from "playwright"
import { BrowserPolicy } from "./policy.js"
import { BrowserEval } from "./eval.js"
import { BrowserCDP, type CDPHandle } from "./cdp.js"
import { BrowserFrameStreamer, type BrowserScreencastFrame, type BrowserScreencastOptions } from "./screencast.js"
import { BrowserInputDispatcher, type BrowserKeyInput, type BrowserMouseInput } from "./input.js"
import { BrowserDownloads } from "./downloads.js"
import { BrowserStorage } from "./storage.js"
import type { BrowserOwner } from "./owner.js"
import { ToolTimeout } from "@/tool/timeout"

export interface AccessibilityElement {
  ref: string
  role: string
  name: string
  value?: string
  children: AccessibilityElement[]
}

export interface ConsoleMessage {
  type: string
  text: string
  timestamp: number
  stackTrace?: string
}

export interface NetworkRequest {
  requestId: string
  url: string
  method: string
  status?: number
  mimeType?: string
  responseHeaders?: Record<string, string>
  timestamp: number
}

export interface BrowserDownloadEntry {
  id: string
  url: string
  fileName: string
  mimeType: string
  state: "in_progress" | "completed" | "cancelled" | "interrupted" | "blocked"
  totalBytes: number
  receivedBytes: number
  timestamp: number
  path?: string
  warning?: string
}

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

export interface BrowserUploadFile {
  name: string
  mimeType?: string
  data: string
}

export interface BrowserTabEventHandlers {
  onLoading?: (tab: BrowserTab, url: string) => void
  onLoaded?: (tab: BrowserTab) => void
  onError?: (tab: BrowserTab, message: string) => void
  onCrashed?: (tab: BrowserTab, message: string) => void
  onDownload?: (tab: BrowserTab, entry: BrowserDownloadEntry) => void
  onFileChooser?: (tab: BrowserTab, request: BrowserFileChooserRequest) => void
  onDialog?: (tab: BrowserTab, request: BrowserDialogRequest) => void
}

export type WaitCondition = { type: "load" } | { type: "url"; contains: string } | { type: "title"; contains: string }

export interface BrowserTab {
  readonly id: string
  url: string
  title: string
  loading: boolean
  pinned: boolean
  kept: boolean
  lastActiveAt: number | null
  readonly cdp: { send(method: string, params?: Record<string, unknown>): Promise<unknown> } | null
  readonly page?: import("playwright").Page

  navigate(url: string): Promise<{ url: string; title: string }>
  navigateForUser(url: string): Promise<{ url: string; title: string }>
  navigateWithOverride(url: string): Promise<{ url: string; title: string }>
  reload(ignoreCache?: boolean): Promise<void>
  goBack(): Promise<void>
  goForward(): Promise<void>
  stop(): Promise<void>
  setViewport(width: number, height: number, deviceScaleFactor?: number): Promise<void>

  click(x: number, y: number): Promise<void>
  type(text: string): Promise<void>
  scroll(deltaX: number, deltaY: number): Promise<void>
  dispatchMouse(action: "move" | "down" | "up" | "wheel", input: BrowserMouseInput): Promise<void>
  dispatchKey(action: "down" | "up", input: BrowserKeyInput): Promise<void>
  insertText(text: string): Promise<void>
  respondToFileChooser(requestId: string, files: BrowserUploadFile[]): Promise<void>
  respondToDialog(requestId: string, accept: boolean, promptText?: string): Promise<void>
  startFrameStream(options: BrowserScreencastOptions, onFrame: (frame: BrowserScreencastFrame) => void): Promise<void>
  stopFrameStream(): Promise<void>
  ensureCDP(): Promise<CDPHandle>
  detachCDP(): Promise<void>

  screenshot(
    format?: "jpeg" | "png",
    quality?: number,
    fullPage?: boolean,
    clip?: { x: number; y: number; width: number; height: number; scale?: number },
  ): Promise<{ buffer: Buffer; width: number; height: number }>
  snapshot(): Promise<{ elements: AccessibilityElement[]; truncated: boolean }>
  consoleEntries(maxEntries?: number): Promise<ConsoleMessage[]>
  networkRequests(maxEntries?: number): Promise<NetworkRequest[]>
  clearDiagnostics(): Promise<void>

  resolveRef(
    ref: string,
  ): Promise<{ backendNodeId: number; x: number; y: number; width: number; height: number } | null>

  evaluate(expression: string, opts?: { throwOnSideEffect?: boolean }): Promise<unknown>
  waitFor(condition: WaitCondition, timeoutMs?: number): Promise<boolean>

  close(): Promise<void>
}

export class BlockedURLNavigationError extends Error {
  readonly url: string
  constructor(reason: string, url: string) {
    super(`Navigation blocked by policy: ${reason}`)
    this.name = "BlockedURLNavigationError"
    this.url = url
  }
}

// ── Constants ──────────────────────────────────────────────────────────

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "combobox",
  "checkbox",
  "radio",
  "menuitem",
  "slider",
  "switch",
  "tab",
  "treeitem",
  "option",
  "listbox",
  "searchbox",
  "spinbutton",
  "menuitemcheckbox",
  "menuitemradio",
  "togglebutton",
])

export const STRUCTURAL_ROLES = new Set([
  "generic",
  "heading",
  "main",
  "nav",
  "section",
  "article",
  "group",
  "list",
  "listitem",
  "region",
  "document",
  "dialog",
  "application",
  "banner",
  "complementary",
  "contentinfo",
  "form",
  "search",
  "row",
  "table",
  "grid",
  "cell",
  "rowgroup",
  "columnheader",
  "rowheader",
  "gridcell",
  "paragraph",
  "none",
])

const MAX_SNAPSHOT_ELEMENTS = 300
const MAX_BUFFER_SIZE = 200

// ── SSR-safe UUID ─────────────────────────────────────────────────────

function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  const hex = () => Math.floor(Math.random() * 16).toString(16)
  return `${hex()}${hex()}${hex()}${hex()}-${hex()}${hex()}-${hex()}${hex()}-${hex()}${hex()}-${hex()}${hex()}${hex()}${hex()}${hex()}${hex()}`
}

// ── Playwright accessibility node shape ────────────────────────────────

interface AriaNode {
  role: string
  name: string
  value?: string | number
  children?: AriaNode[]
}

type RefEntry = { backendNodeId: number; x: number; y: number; width: number; height: number }

// ── BrowserTabImpl ────────────────────────────────────────────────────

export class BrowserTabImpl implements BrowserTab {
  readonly id: string
  url: string = ""
  title: string = ""
  loading: boolean = false
  pinned: boolean = false
  kept: boolean = false
  lastActiveAt: number | null = null

  get cdp(): { send(method: string, params?: Record<string, unknown>): Promise<unknown> } | null {
    return this.cdpHandle
  }

  page: Page
  private directory: string
  private owner: BrowserOwner.Info
  private events: BrowserTabEventHandlers
  private consoleBuffer: ConsoleMessage[] = []
  private networkBuffer: NetworkRequest[] = []
  private refMap = new Map<string, RefEntry>()
  private cdpHandle: CDPHandle | null = null
  private input: BrowserInputDispatcher
  private streamer = new BrowserFrameStreamer()
  private pendingFileChoosers = new Map<string, FileChooser>()
  private pendingDialogs = new Map<string, Dialog>()
  private downloads: BrowserDownloadEntry[] = []

  // Event handler refs for cleanup
  private onConsoleHandler: ((msg: { type(): string; text(): string }) => void) | null = null
  private onRequestHandler: ((req: { url(): string; method(): string }) => void) | null = null
  private onResponseHandler:
    | ((res: { url(): string; status(): number; headers(): Record<string, string> }) => void)
    | null = null
  private onLoadHandler: (() => void) | null = null
  private onFrameNavigatedHandler: ((frame: { parentFrame(): unknown; url(): string }) => void) | null = null
  private onCrashHandler: (() => void) | null = null
  private onDownloadHandler: ((download: Download) => void) | null = null
  private onFileChooserHandler: ((chooser: FileChooser) => void) | null = null
  private onDialogHandler: ((dialog: Dialog) => void) | null = null

  constructor(opts: {
    page: Page
    directory: string
    owner: BrowserOwner.Info
    id?: string
    events?: BrowserTabEventHandlers
  }) {
    this.id = opts.id ?? generateId()
    this.page = opts.page
    this.directory = opts.directory
    this.owner = opts.owner
    this.events = opts.events ?? {}
    this.input = new BrowserInputDispatcher(this.page, () => this.ensureCDP())

    this.setupEventListeners()
  }

  // ── event listeners ───────────────────────────────────────────────

  private setupEventListeners(): void {
    const seenRequestIds = new Set<string>()

    // Console buffer from page.on("console")
    this.onConsoleHandler = (msg) => {
      const type = msg.type()
      const text = msg.text()
      this.consoleBuffer.push({ type, text, timestamp: Date.now() })
      if (this.consoleBuffer.length > MAX_BUFFER_SIZE) this.consoleBuffer.shift()
    }
    this.page.on("console", this.onConsoleHandler)

    // Network buffer from page.on("request")
    this.onRequestHandler = (req) => {
      const url = req.url()
      const method = req.method()
      const requestId = `${method}:${url}:${Date.now()}`
      if (seenRequestIds.has(requestId)) return
      seenRequestIds.add(requestId)
      if (seenRequestIds.size > MAX_BUFFER_SIZE * 2) seenRequestIds.clear()

      this.networkBuffer.push({
        requestId,
        url,
        method,
        timestamp: Date.now(),
      })
      if (this.networkBuffer.length > MAX_BUFFER_SIZE) this.networkBuffer.shift()
    }
    this.page.on("request", this.onRequestHandler)

    // Network buffer from page.on("response")
    this.onResponseHandler = (res) => {
      const resUrl = res.url()
      const existing = this.networkBuffer.find((r) => r.url === resUrl && r.status === undefined)
      if (existing) {
        existing.status = res.status()
        existing.mimeType = res.headers()["content-type"]
        existing.responseHeaders = BrowserPolicy.sanitizeHeaders(res.headers())
      }
    }
    this.page.on("response", this.onResponseHandler)

    this.onLoadHandler = async () => {
      await this.refreshPageInfo()
      this.loading = false
      this.events.onLoaded?.(this)
    }
    this.page.on("load", this.onLoadHandler)

    this.onFrameNavigatedHandler = async (frame) => {
      if (frame.parentFrame()) return
      this.url = frame.url()
      this.loading = true
      this.events.onLoading?.(this, this.url)
      await this.refreshPageInfo()
    }
    this.page.on("framenavigated", this.onFrameNavigatedHandler)

    this.onCrashHandler = () => {
      this.loading = false
      this.events.onCrashed?.(this, "Browser page crashed")
    }
    this.page.on("crash", this.onCrashHandler)

    this.onDownloadHandler = (download) => {
      const id = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const fileName = download.suggestedFilename()
      const url = download.url()
      const matchingRequest = this.networkBuffer.findLast((request) => request.url === url)
      const mimeType = matchingRequest?.mimeType ?? "unknown/unknown"
      const entry: BrowserDownloadEntry = {
        id,
        url,
        fileName,
        mimeType,
        state: "in_progress",
        totalBytes: 0,
        receivedBytes: 0,
        timestamp: Date.now(),
      }
      this.downloads.push(entry)
      BrowserDownloads.add({
        id,
        tabID: this.id,
        url: entry.url,
        suggestedFilename: entry.fileName,
        mimeType,
        state: "pending",
        createdAt: entry.timestamp,
      })

      if (BrowserPolicy.isDangerousDownload({ mimeType, filename: fileName })) {
        entry.state = "blocked"
        entry.warning = `Download blocked by browser safety policy: ${fileName}`
        BrowserDownloads.update(id, { state: "blocked", mimeType })
        download.cancel().catch(() => {})
        this.events.onDownload?.(this, entry)
        return
      }

      this.events.onDownload?.(this, entry)
      download
        .path()
        .then((downloadPath) => {
          entry.state = "completed"
          entry.path = downloadPath ?? undefined
          BrowserDownloads.update(id, { state: "completed", path: downloadPath ?? undefined })
          this.events.onDownload?.(this, entry)
        })
        .catch(() => {
          entry.state = "interrupted"
          BrowserDownloads.update(id, { state: "failed" })
          this.events.onDownload?.(this, entry)
        })
    }
    this.page.on("download", this.onDownloadHandler)

    this.onFileChooserHandler = (chooser) => {
      const requestId = `fc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      this.pendingFileChoosers.set(requestId, chooser)
      const element = chooser.element()
      element
        .evaluate((input) => {
          const el = input as HTMLInputElement
          return {
            multiple: Boolean(el.multiple),
            accept: el.accept
              ? el.accept
                  .split(",")
                  .map((part) => part.trim())
                  .filter(Boolean)
              : [],
          }
        })
        .then((meta) => {
          this.events.onFileChooser?.(this, { requestId, multiple: meta.multiple, accept: meta.accept })
        })
        .catch(() => {
          this.events.onFileChooser?.(this, { requestId, multiple: false, accept: [] })
        })
    }
    this.page.on("filechooser", this.onFileChooserHandler)

    this.onDialogHandler = (dialog) => {
      const requestId = `dialog-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      this.pendingDialogs.set(requestId, dialog)
      this.events.onDialog?.(this, {
        requestId,
        type: dialog.type(),
        message: dialog.message(),
        defaultValue: dialog.defaultValue(),
      })
      setTimeout(() => {
        const pending = this.pendingDialogs.get(requestId)
        if (!pending) return
        this.pendingDialogs.delete(requestId)
        pending.dismiss().catch(() => {})
      }, 30_000)
    }
    this.page.on("dialog", this.onDialogHandler)
  }

  private async refreshPageInfo(): Promise<void> {
    this.url = this.page.url()
    try {
      this.title = await this.page.title()
    } catch {
      this.title = ""
    }
  }

  // ── navigation ─────────────────────────────────────────────────────

  async navigate(url: string): Promise<{ url: string; title: string }> {
    const normalized = BrowserPolicy.normalizeBrowserURL(url)
    const result = BrowserPolicy.evaluateURL(normalized, this.directory)
    if (result.decision === "deny") {
      throw new Error(`Navigation denied: ${result.reason}`)
    }
    if (result.decision === "blocked") {
      throw new BlockedURLNavigationError(result.reason, normalized)
    }

    return this.navigateWithOverride(normalized)
  }

  async navigateForUser(url: string): Promise<{ url: string; title: string }> {
    const normalized = BrowserPolicy.normalizeBrowserURL(url)
    const result = BrowserPolicy.hardCheckNavigation(normalized, this.directory)
    if (result.decision === "deny") {
      throw new Error(`Navigation denied: ${result.reason}`)
    }
    return this.navigateWithOverride(normalized)
  }

  async navigateWithOverride(url: string): Promise<{ url: string; title: string }> {
    this.loading = true
    this.events.onLoading?.(this, url)
    await this.page.goto(url, { waitUntil: "domcontentloaded" })
    await this.refreshPageInfo()
    this.loading = false
    this.events.onLoaded?.(this)

    return { url: this.url, title: this.title }
  }

  async reload(_ignoreCache?: boolean): Promise<void> {
    this.loading = true
    this.events.onLoading?.(this, this.url || this.page.url())
    await this.page.reload({ waitUntil: "domcontentloaded" })
    await this.refreshPageInfo()
    this.loading = false
    this.events.onLoaded?.(this)
  }

  async goBack(): Promise<void> {
    await this.page.goBack()
    await this.refreshPageInfo()
    this.events.onLoaded?.(this)
  }

  async goForward(): Promise<void> {
    await this.page.goForward()
    await this.refreshPageInfo()
    this.events.onLoaded?.(this)
  }

  async stop(): Promise<void> {
    this.loading = false
    try {
      await this.page.evaluate(() => window.stop())
    } catch {
      /* ignore */
    }
  }

  // ── input ──────────────────────────────────────────────────────────

  async click(x: number, y: number): Promise<void> {
    await this.page.mouse.click(x, y)
  }

  async type(text: string): Promise<void> {
    await this.page.keyboard.type(text)
  }

  async scroll(deltaX: number, deltaY: number): Promise<void> {
    await this.page.mouse.wheel(deltaX, deltaY)
  }

  async setViewport(width: number, height: number, deviceScaleFactor?: number): Promise<void> {
    await this.page.setViewportSize({ width, height })
    if (deviceScaleFactor && Number.isFinite(deviceScaleFactor) && deviceScaleFactor > 0 && deviceScaleFactor !== 1) {
      const cdp = await this.ensureCDP()
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor,
        mobile: false,
      })
      return
    }
    if (deviceScaleFactor === 1 && this.cdpHandle) {
      await this.cdpHandle.send("Emulation.clearDeviceMetricsOverride").catch(() => {})
    }
  }

  async dispatchMouse(action: "move" | "down" | "up" | "wheel", input: BrowserMouseInput): Promise<void> {
    if (action === "move") return this.input.mouseMove(input)
    if (action === "down") return this.input.mouseDown(input)
    if (action === "up") return this.input.mouseUp(input)
    return this.input.mouseWheel(input)
  }

  async dispatchKey(action: "down" | "up", input: BrowserKeyInput): Promise<void> {
    if (action === "down") return this.input.keyDown(input)
    return this.input.keyUp(input)
  }

  async insertText(text: string): Promise<void> {
    await this.input.insertText(text)
  }

  async respondToFileChooser(requestId: string, files: BrowserUploadFile[]): Promise<void> {
    const chooser = this.pendingFileChoosers.get(requestId)
    if (!chooser) throw new Error(`File chooser request ${requestId} is no longer available`)
    this.pendingFileChoosers.delete(requestId)

    if (files.length === 0) {
      await chooser.setFiles([])
      return
    }

    const uploadDir = path.join(BrowserStorage.uploadsDir(this.owner), requestId)
    await fs.mkdir(uploadDir, { recursive: true })
    const paths: string[] = []
    for (const [index, file] of files.entries()) {
      const safeName = path.basename(file.name || `upload-${index}`)
      const filepath = path.join(uploadDir, safeName)
      await Bun.write(filepath, Buffer.from(file.data, "base64"))
      paths.push(filepath)
    }
    await chooser.setFiles(paths)
  }

  async respondToDialog(requestId: string, accept: boolean, promptText?: string): Promise<void> {
    const dialog = this.pendingDialogs.get(requestId)
    if (!dialog) throw new Error(`Dialog request ${requestId} is no longer available`)
    this.pendingDialogs.delete(requestId)
    if (accept) {
      await dialog.accept(promptText)
      return
    }
    await dialog.dismiss()
  }

  async startFrameStream(
    options: BrowserScreencastOptions,
    onFrame: (frame: BrowserScreencastFrame) => void,
  ): Promise<void> {
    await this.streamer.start(this.id, this.page, options, onFrame)
  }

  async stopFrameStream(): Promise<void> {
    await this.streamer.stop(this.id)
  }

  async ensureCDP(): Promise<CDPHandle> {
    if (!this.cdpHandle) {
      this.cdpHandle = await BrowserCDP.attach(this.page)
    }
    return this.cdpHandle
  }

  async detachCDP(): Promise<void> {
    if (!this.cdpHandle) return
    const handle = this.cdpHandle
    this.cdpHandle = null
    await handle.detach().catch(() => {})
  }

  // ── screenshot ─────────────────────────────────────────────────────

  async screenshot(
    _format?: "jpeg" | "png",
    _quality?: number,
    _fullPage?: boolean,
    _clip?: { x: number; y: number; width: number; height: number; scale?: number },
  ): Promise<{ buffer: Buffer; width: number; height: number }> {
    const result = await this.page.screenshot()

    let width = 1280
    let height = 720
    try {
      const vp = await this.page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }))
      width = vp.width
      height = vp.height
    } catch {
      /* defaults */
    }

    return { buffer: result, width, height }
  }

  // ── snapshot ───────────────────────────────────────────────────────

  async snapshot(): Promise<{ elements: AccessibilityElement[]; truncated: boolean }> {
    let tree: AriaNode | null = null
    const ariaSnapshot = (this.page as unknown as { ariaSnapshot?: () => Promise<AriaNode | null> }).ariaSnapshot
    if (ariaSnapshot) {
      try {
        tree = await ariaSnapshot.call(this.page)
      } catch {
        tree = null
      }
    }

    if (!tree) {
      return this.snapshotViaCDP()
    }

    let refCounter = 0
    const elements: AccessibilityElement[] = []
    const refMap = this.refMap
    refMap.clear()

    function walk(node: AriaNode): AccessibilityElement | null {
      const role = (node.role ?? "unknown").toLowerCase()
      const name = node.name ?? ""
      const value = node.value != null ? String(node.value) : undefined

      const isInteractive = INTERACTIVE_ROLES.has(role)
      const isStructural = STRUCTURAL_ROLES.has(role)

      let ref = ""
      if (isInteractive && refCounter < MAX_SNAPSHOT_ELEMENTS) {
        refCounter++
        ref = `@e${refCounter}`
        refMap.set(ref, { backendNodeId: 0, x: 0, y: 0, width: 0, height: 0 })
      }

      const children: AccessibilityElement[] = []
      if (node.children) {
        for (const child of node.children) {
          const el = walk(child)
          if (el) children.push(el)
        }
      }

      if (!ref && children.length === 0 && !isStructural) return null

      return { ref, role, name, value, children }
    }

    if (tree.children) {
      for (const child of tree.children) {
        const el = walk(child)
        if (el) elements.push(el)
      }
    }

    return { elements, truncated: refCounter >= MAX_SNAPSHOT_ELEMENTS }
  }

  private async snapshotViaCDP(): Promise<{ elements: AccessibilityElement[]; truncated: boolean }> {
    const cdp = await this.ensureCDP()
    const result = (await cdp.send("Accessibility.getFullAXTree")) as {
      nodes?: Array<{
        nodeId: string
        parentId?: string
        role?: { value?: string }
        name?: { value?: string }
        value?: { value?: string | number }
        ignored?: boolean
      }>
    }
    const nodes = result.nodes ?? []
    const byParent = new Map<string, typeof nodes>()
    for (const node of nodes) {
      if (!node.parentId) continue
      const list = byParent.get(node.parentId) ?? []
      list.push(node)
      byParent.set(node.parentId, list)
    }

    let refCounter = 0
    this.refMap.clear()

    const walk = (node: (typeof nodes)[number]): AccessibilityElement | null => {
      if (node.ignored) return null
      const role = String(node.role?.value ?? "generic").toLowerCase()
      const name = String(node.name?.value ?? "")
      const value = node.value?.value != null ? String(node.value.value) : undefined
      const isInteractive = INTERACTIVE_ROLES.has(role)
      const isStructural = STRUCTURAL_ROLES.has(role)
      let ref = ""
      if (isInteractive && refCounter < MAX_SNAPSHOT_ELEMENTS) {
        refCounter++
        ref = `@e${refCounter}`
        this.refMap.set(ref, { backendNodeId: 0, x: 0, y: 0, width: 0, height: 0 })
      }
      const children = (byParent.get(node.nodeId) ?? []).map(walk).filter((x): x is AccessibilityElement => Boolean(x))
      if (!ref && children.length === 0 && !isStructural) return null
      return { ref, role, name, value, children }
    }

    const roots = nodes.filter((node) => !node.parentId)
    const elements = roots.map(walk).filter((x): x is AccessibilityElement => Boolean(x))
    return { elements, truncated: refCounter >= MAX_SNAPSHOT_ELEMENTS }
  }

  // ── console + network buffers ──────────────────────────────────────

  async consoleEntries(maxEntries?: number): Promise<ConsoleMessage[]> {
    const max = maxEntries ?? MAX_BUFFER_SIZE
    return this.consoleBuffer.slice(-max)
  }

  async networkRequests(maxEntries?: number): Promise<NetworkRequest[]> {
    const max = maxEntries ?? MAX_BUFFER_SIZE
    return this.networkBuffer.slice(-max)
  }

  async clearDiagnostics(): Promise<void> {
    this.consoleBuffer = []
    this.networkBuffer = []
  }

  // ── ref resolution ─────────────────────────────────────────────────

  async resolveRef(
    ref: string,
  ): Promise<{ backendNodeId: number; x: number; y: number; width: number; height: number } | null> {
    const stored = this.refMap.get(ref)
    if (!stored) return null

    try {
      const box = await this.page.evaluate(
        ([refId]) => {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT)
          let idx = 0
          let node: Element | null
          while ((node = walker.nextNode() as Element | null)) {
            const tag = node.tagName.toLowerCase()
            if (!["button", "a", "input", "select", "textarea"].includes(tag)) continue
            idx++
            if (`@e${idx}` === refId) {
              const r = node.getBoundingClientRect()
              return { x: r.x, y: r.y, width: r.width, height: r.height }
            }
          }
          return null
        },
        [ref],
      )
      if (box) {
        stored.x = box.x
        stored.y = box.y
        stored.width = box.width
        stored.height = box.height
        this.refMap.set(ref, stored)
      }
    } catch {
      /* leave as-is */
    }

    return stored
  }

  async evaluate(expression: string, opts?: { throwOnSideEffect?: boolean }): Promise<unknown> {
    if (opts?.throwOnSideEffect) return BrowserEval.evaluateReadonly(this.page, expression)
    return this.page.evaluate(expression)
  }

  // ── wait ───────────────────────────────────────────────────────────

  async waitFor(condition: WaitCondition, timeoutMs?: number): Promise<boolean> {
    const timeout = timeoutMs ?? ToolTimeout.DEFAULTS.browserWaitMs
    const start = Date.now()

    while (Date.now() - start < timeout) {
      switch (condition.type) {
        case "load":
          if (!this.loading) return true
          break
        case "url":
          if (this.url.includes(condition.contains)) return true
          break
        case "title":
          if (this.title.includes(condition.contains)) return true
          break
      }
      await new Promise((r) => setTimeout(r, 100))
    }

    return false
  }

  // ── close ──────────────────────────────────────────────────────────

  async close(): Promise<void> {
    await this.stopFrameStream()
    await this.detachCDP()
    if (this.onConsoleHandler) this.page.off("console", this.onConsoleHandler)
    if (this.onRequestHandler) this.page.off("request", this.onRequestHandler)
    if (this.onResponseHandler) this.page.off("response", this.onResponseHandler)
    if (this.onLoadHandler) this.page.off("load", this.onLoadHandler)
    if (this.onFrameNavigatedHandler) this.page.off("framenavigated", this.onFrameNavigatedHandler)
    if (this.onCrashHandler) this.page.off("crash", this.onCrashHandler)
    if (this.onDownloadHandler) this.page.off("download", this.onDownloadHandler)
    if (this.onFileChooserHandler) this.page.off("filechooser", this.onFileChooserHandler)
    if (this.onDialogHandler) this.page.off("dialog", this.onDialogHandler)

    try {
      await this.page.close()
    } catch {
      /* ignore */
    }

    this.consoleBuffer = []
    this.networkBuffer = []
    this.refMap.clear()
    this.pendingFileChoosers.clear()
    this.pendingDialogs.clear()
  }
}
