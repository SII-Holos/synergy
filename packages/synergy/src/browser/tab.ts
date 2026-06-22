import type { Page } from "playwright"
import { BrowserPolicy } from "./policy.js"
import { BrowserEval } from "./eval.js"

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
  navigateWithOverride(url: string): Promise<{ url: string; title: string }>
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
    clip?: { x: number; y: number; width: number; height: number; scale?: number },
  ): Promise<{ buffer: Buffer; width: number; height: number }>
  snapshot(): Promise<{ elements: AccessibilityElement[]; truncated: boolean }>
  consoleEntries(maxEntries?: number): Promise<ConsoleMessage[]>
  networkRequests(maxEntries?: number): Promise<NetworkRequest[]>

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

  readonly cdp: { send(method: string, params?: Record<string, unknown>): Promise<unknown> } | null = null

  page: Page
  private directory: string
  private consoleBuffer: ConsoleMessage[] = []
  private networkBuffer: NetworkRequest[] = []
  private refMap = new Map<string, RefEntry>()

  // Event handler refs for cleanup
  private onConsoleHandler: ((msg: { type(): string; text(): string }) => void) | null = null
  private onRequestHandler: ((req: { url(): string; method(): string }) => void) | null = null
  private onResponseHandler:
    | ((res: { url(): string; status(): number; headers(): Record<string, string> }) => void)
    | null = null

  constructor(opts: { page: Page; directory: string; id?: string }) {
    this.id = opts.id ?? generateId()
    this.page = opts.page
    this.directory = opts.directory

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
        existing.mimeType = undefined
        existing.responseHeaders = res.headers()
      }
    }
    this.page.on("response", this.onResponseHandler)
  }

  // ── navigation ─────────────────────────────────────────────────────

  async navigate(url: string): Promise<{ url: string; title: string }> {
    const result = BrowserPolicy.evaluateURL(url, this.directory)
    if (result.decision === "deny") {
      throw new Error(`Navigation denied: ${result.reason}`)
    }
    if (result.decision === "blocked") {
      throw new BlockedURLNavigationError(result.reason, url)
    }

    this.loading = true
    await this.page.goto(url, { waitUntil: "domcontentloaded" })
    this.url = this.page.url()

    try {
      this.title = await this.page.evaluate(() => document.title)
    } catch {
      /* ignore */
    }
    this.loading = false

    return { url: this.url, title: this.title }
  }

  async navigateWithOverride(url: string): Promise<{ url: string; title: string }> {
    this.loading = true
    await this.page.goto(url, { waitUntil: "domcontentloaded" })
    this.url = this.page.url()

    try {
      this.title = await this.page.evaluate(() => document.title)
    } catch {
      /* ignore */
    }
    this.loading = false

    return { url: this.url, title: this.title }
  }

  async reload(_ignoreCache?: boolean): Promise<void> {
    this.loading = true
    await this.page.reload()
    this.loading = false
  }

  async goBack(): Promise<void> {
    await this.page.goBack()
  }

  async goForward(): Promise<void> {
    await this.page.goForward()
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
    // @ts-expect-error — Playwright 1.61 Page has ariaSnapshot but TS types may not expose it on Page directly
    const tree = (await this.page.ariaSnapshot()) as AriaNode | null

    if (!tree) {
      return { elements: [], truncated: false }
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
    if (this.onConsoleHandler) this.page.off("console", this.onConsoleHandler)
    if (this.onRequestHandler) this.page.off("request", this.onRequestHandler)
    if (this.onResponseHandler) this.page.off("response", this.onResponseHandler)

    try {
      await this.page.close()
    } catch {
      /* ignore */
    }

    this.consoleBuffer = []
    this.networkBuffer = []
    this.refMap.clear()
  }
}
