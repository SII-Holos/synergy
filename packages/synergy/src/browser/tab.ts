import { CdpClient } from "./cdp.js"
import { BrowserPolicy } from "./policy.js"

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
  timestamp: number
}

export type WaitCondition = { type: "load" } | { type: "url"; contains: string } | { type: "title"; contains: string }

export interface BrowserTab {
  readonly id: string
  url: string
  title: string
  loading: boolean
  readonly cdp: CdpClient.Connection | null

  navigate(url: string): Promise<{ url: string; title: string }>
  reload(ignoreCache?: boolean): Promise<void>
  goBack(): Promise<void>
  goForward(): Promise<void>
  stop(): Promise<void>

  click(x: number, y: number): Promise<void>
  type(text: string): Promise<void>
  scroll(deltaX: number, deltaY: number): Promise<void>

  screenshot(
    format?: "jpeg" | "png",
    quality?: number,
    fullPage?: boolean,
  ): Promise<{ buffer: Buffer; width: number; height: number }>
  snapshot(): Promise<{ elements: AccessibilityElement[]; truncated: boolean }>
  consoleEntries(maxEntries?: number): Promise<ConsoleMessage[]>
  networkRequests(maxEntries?: number): Promise<NetworkRequest[]>

  resolveRef(
    ref: string,
  ): Promise<{ backendNodeId: number; x: number; y: number; width: number; height: number } | null>

  evaluate(expression: string): Promise<unknown>
  waitFor(condition: WaitCondition, timeoutMs?: number): Promise<boolean>

  close(): Promise<void>
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

// ── AXTree node shape (partial CDP) ───────────────────────────────────

interface AXNode {
  nodeId: string
  role?: { value: string }
  name?: { value: string }
  value?: { value: string }
  childIds?: string[]
  backendDOMNodeId?: number
}

type RefEntry = { backendNodeId: number; x: number; y: number; width: number; height: number }

// ── BrowserTabImpl ────────────────────────────────────────────────────

export class BrowserTabImpl implements BrowserTab {
  readonly id: string
  url: string = ""
  title: string = ""
  loading: boolean = false

  private _cdp: CdpClient.Connection | null = null
  get cdp(): CdpClient.Connection | null {
    return this._cdp
  }

  private sessionId: string | null = null
  private targetId?: string
  private browserCdp: CdpClient.Connection
  private directory: string
  private refMap = new Map<string, RefEntry>()
  private consoleBuffer: ConsoleMessage[] = []
  private networkBuffer: NetworkRequest[] = []

  // Event handler refs for cleanup
  private onFrameNavigated: ((params: Record<string, unknown>) => void) | null = null
  private onLoadEventFired: ((params: Record<string, unknown>) => void) | null = null
  private onConsoleMessage: ((params: Record<string, unknown>) => void) | null = null
  private onRequestWillBeSent: ((params: Record<string, unknown>) => void) | null = null
  private onResponseReceived: ((params: Record<string, unknown>) => void) | null = null

  private browserContextId: string | null

  constructor(opts: { browserCdp: CdpClient.Connection; directory: string; id?: string; browserContextId?: string }) {
    this.id = opts.id ?? generateId()
    this.browserCdp = opts.browserCdp
    this.directory = opts.directory
    this.browserContextId = opts.browserContextId ?? null
  }
  // ── helpers ────────────────────────────────────────────────────────

  private async ensureSession(): Promise<string> {
    if (this.sessionId) return this.sessionId

    const params: Record<string, unknown> = { url: "about:blank" }
    if (this.browserContextId) {
      params.browserContextId = this.browserContextId
    }
    const createResult = await this.browserCdp.send("Target.createTarget", params)
    const { targetId } = createResult as { targetId: string }
    this.targetId = targetId

    const attachResult = await this.browserCdp.send("Target.attachToTarget", { targetId, flatten: true })
    this.sessionId = (attachResult as { sessionId: string }).sessionId
    this._cdp = this.browserCdp

    await this.sendCmd("Page.enable")
    await this.sendCmd("Runtime.enable")
    await this.sendCmd("Network.enable")

    this.setupEventListeners()

    return this.sessionId
  }

  private sendCmd(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.sessionId) {
      throw new Error("Browser tab is not attached to a CDP session. Call ensureSession() first.")
    }
    return this.browserCdp.send(method, params, this.sessionId)
  }

  private setupEventListeners(): void {
    const sid = this.sessionId!

    this.onFrameNavigated = (params: Record<string, unknown>) => {
      const frame = params.frame as { url?: string; parentId?: string } | undefined
      if (frame?.url && frame.parentId == null) {
        this.url = frame.url
      }
    }
    this.browserCdp.on("Page.frameNavigated", this.onFrameNavigated, sid)

    const seenRequestIds = new Set<string>()

    this.onLoadEventFired = () => {
      this.loading = false
      this.sendCmd("Runtime.evaluate", {
        expression: "document.title",
        returnByValue: true,
      })
        .then((result) => {
          const value = (result as { result?: { value?: string } }).result?.value
          if (typeof value === "string") this.title = value
        })
        .catch(() => {
          /* ignore */
        })
    }
    this.browserCdp.on("Page.loadEventFired", this.onLoadEventFired, sid)

    this.onConsoleMessage = (params: Record<string, unknown>) => {
      const type = (params.type as string) ?? "log"
      const args = params.args as Array<{ value?: string; description?: string }> | undefined
      const text = args?.map((a) => a.value ?? a.description ?? "").join(" ") ?? ""
      this.consoleBuffer.push({ type, text, timestamp: Date.now() })
      if (this.consoleBuffer.length > MAX_BUFFER_SIZE) this.consoleBuffer.shift()
    }
    this.browserCdp.on("Runtime.consoleAPICalled", this.onConsoleMessage, sid)

    this.onRequestWillBeSent = (params: Record<string, unknown>) => {
      if (seenRequestIds.has(params.requestId as string)) return
      seenRequestIds.add(params.requestId as string)
      if (seenRequestIds.size > MAX_BUFFER_SIZE * 2) seenRequestIds.clear()

      const request = params.request as { url: string; method: string } | undefined
      if (!request) return
      this.networkBuffer.push({
        requestId: params.requestId as string,
        url: request.url,
        method: request.method,
        timestamp: Date.now(),
      })
      if (this.networkBuffer.length > MAX_BUFFER_SIZE) this.networkBuffer.shift()
    }
    this.browserCdp.on("Network.requestWillBeSent", this.onRequestWillBeSent, sid)

    this.onResponseReceived = (params: Record<string, unknown>) => {
      const existing = this.networkBuffer.find((r) => r.requestId === params.requestId)
      if (existing) {
        const response = params.response as { status: number; mimeType: string } | undefined
        if (response) {
          existing.status = response.status
          existing.mimeType = response.mimeType
        }
      }
    }
    this.browserCdp.on("Network.responseReceived", this.onResponseReceived, sid)
  }

  // ── navigation ─────────────────────────────────────────────────────

  async navigate(url: string): Promise<{ url: string; title: string }> {
    const result = BrowserPolicy.evaluateURL(url, this.directory)
    if (result.decision !== "allow") {
      throw new Error(`Navigation denied: ${result.reason}`)
    }

    await this.ensureSession()

    this.loading = true
    await this.sendCmd("Page.navigate", { url })
    this.url = url

    try {
      const evalResult = await this.sendCmd("Runtime.evaluate", {
        expression: "document.title",
        returnByValue: true,
      })
      const value = (evalResult as { result?: { value?: string } }).result?.value
      if (typeof value === "string") this.title = value
    } catch {
      /* ignore */
    }

    return { url: this.url, title: this.title }
  }

  async reload(ignoreCache?: boolean): Promise<void> {
    this.loading = true
    await this.sendCmd("Page.reload", ignoreCache ? { ignoreCache: true } : undefined)
  }

  async goBack(): Promise<void> {
    await this.sendCmd("Runtime.evaluate", { expression: "window.history.back()" })
  }

  async goForward(): Promise<void> {
    await this.sendCmd("Runtime.evaluate", { expression: "window.history.forward()" })
  }

  async stop(): Promise<void> {
    this.loading = false
    await this.sendCmd("Page.stopLoading")
  }

  // ── input ──────────────────────────────────────────────────────────

  async click(x: number, y: number): Promise<void> {
    await this.sendCmd("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    })
    await this.sendCmd("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    })
  }

  async type(text: string): Promise<void> {
    await this.sendCmd("Input.insertText", { text })
  }

  async scroll(deltaX: number, deltaY: number): Promise<void> {
    await this.sendCmd("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 0,
      y: 0,
      deltaX,
      deltaY,
    })
  }

  // ── screenshot ─────────────────────────────────────────────────────

  async screenshot(
    format?: "jpeg" | "png",
    quality?: number,
    fullPage?: boolean,
  ): Promise<{ buffer: Buffer; width: number; height: number }> {
    const params: Record<string, unknown> = {}
    if (format) params.format = format
    if (quality !== undefined) params.quality = quality
    if (fullPage) params.captureBeyondViewport = true

    const layout = (await this.sendCmd("Page.getLayoutMetrics")) as {
      cssContentSize?: { width: number; height: number }
      cssVisualViewport?: { clientWidth: number; clientHeight: number }
    }
    const width = fullPage ? (layout.cssContentSize?.width ?? 1280) : (layout.cssVisualViewport?.clientWidth ?? 1280)
    const height = fullPage ? (layout.cssContentSize?.height ?? 720) : (layout.cssVisualViewport?.clientHeight ?? 720)

    const result = (await this.sendCmd("Page.captureScreenshot", params)) as { data: string }
    return { buffer: Buffer.from(result.data, "base64"), width, height }
  }

  // ── snapshot ───────────────────────────────────────────────────────

  async snapshot(): Promise<{ elements: AccessibilityElement[]; truncated: boolean }> {
    const result = (await this.sendCmd("Accessibility.getFullAXTree", { depth: 6 })) as {
      nodes: AXNode[]
    }
    const nodes = result.nodes

    if (!nodes || nodes.length === 0) {
      return { elements: [], truncated: false }
    }

    const nodeMap = new Map<string, AXNode>()
    for (const node of nodes) {
      nodeMap.set(node.nodeId, node)
    }

    let refCounter = 0
    const elements: AccessibilityElement[] = []
    const refMap = this.refMap
    refMap.clear()

    function getRole(node: AXNode): string {
      return node.role?.value?.toLowerCase() ?? "unknown"
    }

    const walkAndTrack = (nodeId: string): AccessibilityElement | null => {
      const node = nodeMap.get(nodeId)
      if (!node) return null

      const role = getRole(node)
      const name = node.name?.value ?? ""
      const nodeValue = node.value?.value
      const backendNodeId = node.backendDOMNodeId
      const childIds = node.childIds ?? []

      const isInteractive = INTERACTIVE_ROLES.has(role)
      const isStructural = STRUCTURAL_ROLES.has(role)

      let ref = ""
      if (isInteractive && refCounter < MAX_SNAPSHOT_ELEMENTS) {
        refCounter++
        ref = `@e${refCounter}`
        if (backendNodeId != null) {
          refMap.set(ref, { backendNodeId, x: 0, y: 0, width: 0, height: 0 })
        }
      }

      const children: AccessibilityElement[] = []
      for (const cid of childIds) {
        const child = walkAndTrack(cid)
        if (child) children.push(child)
      }

      if (!ref && children.length === 0 && !isStructural) return null

      return { ref, role, name, value: nodeValue, children }
    }

    const rootId = nodes[0]?.nodeId
    if (rootId) {
      const rootNode = nodeMap.get(rootId)
      if (rootNode?.childIds) {
        for (const cid of rootNode.childIds) {
          const child = walkAndTrack(cid)
          if (child) elements.push(child)
        }
      }
    }

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

  // ── ref resolution ─────────────────────────────────────────────────

  async resolveRef(
    ref: string,
  ): Promise<{ backendNodeId: number; x: number; y: number; width: number; height: number } | null> {
    const stored = this.refMap.get(ref)
    if (!stored) return null

    if (stored.width !== 0 || stored.height !== 0) return stored

    try {
      const resolveResult = (await this.sendCmd("DOM.resolveNode", {
        backendNodeId: stored.backendNodeId,
      })) as { object?: { objectId: string } }
      const objectId = resolveResult.object?.objectId
      if (!objectId) return stored

      const boxResult = (await this.sendCmd("Runtime.callFunctionOn", {
        functionDeclaration: `function() {
          const r = this.getBoundingClientRect()
          return { x: r.x, y: r.y, width: r.width, height: r.height }
        }`,
        objectId,
        returnByValue: true,
      })) as { result?: { value?: { x: number; y: number; width: number; height: number } } }

      const box = boxResult.result?.value
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

  async evaluate(expression: string): Promise<unknown> {
    await this.ensureSession()
    const result = await this.sendCmd("Runtime.evaluate", { expression, returnByValue: true })
    return (result as { result?: { value?: unknown } }).result?.value
  }

  // ── wait ───────────────────────────────────────────────────────────

  async waitFor(condition: WaitCondition, timeoutMs?: number): Promise<boolean> {
    const timeout = timeoutMs ?? 10_000
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
    const sid = this.sessionId
    if (sid) {
      if (this.onFrameNavigated) this.browserCdp.off("Page.frameNavigated", this.onFrameNavigated, sid)
      if (this.onLoadEventFired) this.browserCdp.off("Page.loadEventFired", this.onLoadEventFired, sid)
      if (this.onConsoleMessage) this.browserCdp.off("Runtime.consoleAPICalled", this.onConsoleMessage, sid)
      if (this.onRequestWillBeSent) this.browserCdp.off("Network.requestWillBeSent", this.onRequestWillBeSent, sid)
      if (this.onResponseReceived) this.browserCdp.off("Network.responseReceived", this.onResponseReceived, sid)
    }

    if (this._cdp) {
      if (this.sessionId) {
        await this._cdp.send("Target.detachFromTarget", { sessionId: this.sessionId }).catch(() => {})
      }
      if (this.targetId) {
        await this._cdp.send("Target.closeTarget", { targetId: this.targetId }).catch(() => {})
      }
    }

    this.sessionId = null
    this._cdp = null
    this.consoleBuffer = []
    this.networkBuffer = []
    this.refMap.clear()
  }
}
