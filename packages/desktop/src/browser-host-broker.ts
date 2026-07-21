import {
  BROWSER_PROTOCOL_VERSION,
  BrowserIceServerSchema,
  BrowserHostMessageSchema,
  BrowserProtocolError,
  BrowserRegistrationSecretSchema,
  type BrowserBackendResult,
  type BrowserHostMessage,
  type BrowserHostPageEvent,
} from "@ericsanchezok/synergy-browser"
import { BrowserWebRTCHost } from "./browser-webrtc-host.js"
import { type DesktopThemeSnapshot } from "./theme.js"
import { BrowserNativePagePool, type BrowserNativePageHandle } from "./browser-native-page-pool.js"

export interface BrowserHostBrokerOptions {
  serverUrl: string
  token: string
  hostId?: string
  nativePool?: BrowserNativePagePool
  theme: DesktopThemeSnapshot
}

type ManagedPage = BrowserWebRTCHost | BrowserNativePageHandle
interface ManagedPageEntry {
  pageId: string
  page: ManagedPage
}

function isThemeAwarePage(page: ManagedPage): page is BrowserWebRTCHost {
  return "setTheme" in page
}

export class BrowserHostBrokerClient {
  private socket: WebSocket | null = null
  private pages = new Map<string, ManagedPageEntry>()
  private commandTails = new Map<string, Promise<void>>()
  private closed = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private connectionEpoch = 0
  private disconnecting: Promise<void> | null = null

  private options: BrowserHostBrokerOptions
  private theme: DesktopThemeSnapshot

  constructor(options: BrowserHostBrokerOptions) {
    this.options = { ...options, token: BrowserRegistrationSecretSchema.parse(options.token) }
    this.theme = options.theme
  }

  setTheme(theme: DesktopThemeSnapshot): void {
    this.theme = theme
    for (const entry of this.pages.values()) {
      if (isThemeAwarePage(entry.page)) entry.page.setTheme(theme)
    }
  }

  connect(): void {
    if (this.closed || this.socket || this.disconnecting) return
    const url = new URL("/browser/host/broker", this.options.serverUrl)
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    url.searchParams.set("protocolVersion", String(BROWSER_PROTOCOL_VERSION))
    const socket = new WebSocket(url)
    const epoch = ++this.connectionEpoch
    this.socket = socket
    socket.addEventListener("open", () => {
      this.send({
        type: "host.register",
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        hostId: this.options.hostId ?? `browser-host-${process.pid}`,
        token: this.options.token,
        capabilities: { native: Boolean(this.options.nativePool), webrtc: true },
      })
    })
    socket.addEventListener("message", (event) => void this.handle(event.data, epoch))
    socket.addEventListener("error", () => {
      console.error("Browser Host broker connection failed.")
    })
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return
      this.connectionEpoch++
      this.socket = null
      const pages = this.takePages()
      this.commandTails.clear()
      const disconnecting = destroyPages(pages)
      this.disconnecting = disconnecting
      void disconnecting
        .catch((error) => console.error("Browser Host page cleanup failed after broker disconnect.", error))
        .finally(() => {
          if (this.disconnecting === disconnecting) this.disconnecting = null
          if (!this.closed) this.reconnectTimer = setTimeout(() => this.connect(), 1_000)
        })
    })
  }

  async close(): Promise<void> {
    this.closed = true
    this.connectionEpoch++
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    const socket = this.socket
    this.socket = null
    socket?.close()
    const pages = this.takePages()
    this.commandTails.clear()
    const failures: unknown[] = []
    if (this.disconnecting) {
      try {
        await this.disconnecting
      } catch (error) {
        failures.push(error)
      }
    }
    try {
      await destroyPages(pages)
    } catch (error) {
      failures.push(error)
    }
    if (failures.length) throw new AggregateError(failures, "Browser Host pages did not close cleanly.")
  }

  private async handle(data: unknown, epoch: number): Promise<void> {
    if (epoch !== this.connectionEpoch) return
    if (Buffer.byteLength(String(data), "utf8") > 80 * 1024 * 1024) {
      this.socket?.close(1009, "Browser Host command is too large")
      return
    }
    let message: BrowserHostMessage
    try {
      message = BrowserHostMessageSchema.parse(JSON.parse(String(data)))
    } catch {
      this.socket?.close(1003, "Invalid Browser Host message")
      return
    }
    if (message.type === "host.registered") return
    if (message.type !== "page.create" && message.type !== "page.close" && message.type !== "page.command") {
      this.socket?.close(1008, "Browser Host received a message for the wrong protocol role")
      return
    }
    const previous = this.commandTails.get(message.ownerKey) ?? Promise.resolve()
    const operation = previous.then(() => this.dispatch(message, epoch))
    this.commandTails.set(message.ownerKey, operation)
    try {
      await operation
    } finally {
      if (this.commandTails.get(message.ownerKey) === operation) this.commandTails.delete(message.ownerKey)
    }
  }

  private async dispatch(
    message: Extract<BrowserHostMessage, { type: "page.create" | "page.close" | "page.command" }>,
    epoch: number,
  ): Promise<void> {
    if (epoch !== this.connectionEpoch) return
    if (message.type === "page.create") {
      try {
        if (this.pages.has(message.ownerKey)) throw new Error("Browser owner already has an active Host page.")
        const page =
          message.presentation === "native"
            ? await this.createNativePage(message)
            : await this.createWebRTCPage(message)
        if (epoch !== this.connectionEpoch || this.socket?.readyState !== WebSocket.OPEN) {
          await page.destroy()
          return
        }
        if (isThemeAwarePage(page)) page.setTheme(this.theme)
        this.pages.set(message.ownerKey, { pageId: message.page.id, page })
        this.result(message.requestId, { type: "page", page: page.state() })
      } catch (error) {
        this.failure(message.requestId, error)
      }
      return
    }
    if (message.type === "page.close") {
      const entry = this.pages.get(message.ownerKey)
      if (!entry || entry.pageId !== message.pageId) {
        this.failure(message.requestId, new Error("Browser Host page was not found."))
        return
      }
      try {
        await entry.page.destroy()
        this.pages.delete(message.ownerKey)
        this.result(message.requestId, { type: "void" })
      } catch (error) {
        if (!entry.page.isAlive()) {
          this.pages.delete(message.ownerKey)
          console.error("Browser Host page closed with cleanup errors.", error)
          this.result(message.requestId, { type: "void" })
          return
        }
        this.failure(message.requestId, error)
      }
      return
    }
    if (message.type !== "page.command") return
    const entry = this.pages.get(message.ownerKey)
    if (!entry || entry.pageId !== message.pageId) {
      this.failure(message.requestId, new Error("Browser Host page was not found."))
      return
    }
    try {
      this.result(message.requestId, await entry.page.execute(message.command))
    } catch (error) {
      this.failure(message.requestId, error)
    }
  }

  private result(requestId: string, result: BrowserBackendResult): void {
    this.send({ type: "page.result", protocolVersion: BROWSER_PROTOCOL_VERSION, requestId, result })
  }

  private failure(requestId: string, error: unknown): void {
    const normalized = BrowserProtocolError.from(error, {
      code: "browser_host_command_failed",
      message: error instanceof Error ? error.message : "Browser Host command failed.",
      retryable: false,
    })
    this.send({ type: "page.result", protocolVersion: BROWSER_PROTOCOL_VERSION, requestId, error: normalized.toJSON() })
  }

  private send(message: BrowserHostMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
  }

  private event(ownerKey: string, pageId: string, event: BrowserHostPageEvent): void {
    this.send({ type: "page.event", protocolVersion: BROWSER_PROTOCOL_VERSION, ownerKey, pageId, event })
  }

  private async createNativePage(
    message: Extract<BrowserHostMessage, { type: "page.create" }>,
  ): Promise<BrowserNativePageHandle> {
    if (!this.options.nativePool) throw new Error("This Browser Host has no native page capability.")
    return this.options.nativePool.create({
      ownerKey: message.ownerKey,
      page: message.page,
      networkProxy: message.networkProxy,
      downloadDir: message.downloadDir,
      emit: (event) => this.event(message.ownerKey, message.page.id, event),
    })
  }

  private async createWebRTCPage(
    message: Extract<BrowserHostMessage, { type: "page.create" }>,
  ): Promise<BrowserWebRTCHost> {
    if (!message.signalingTicket) throw new Error("Browser Host signaling ticket is missing.")
    const page = new BrowserWebRTCHost({
      ownerKey: message.ownerKey,
      serverUrl: this.options.serverUrl,
      ownerMode: message.owner.mode,
      sessionID: message.owner.sessionID,
      pageId: message.page.id,
      routeDirectory: message.routeDirectory,
      url: message.page.url,
      theme: this.theme,
      iceServers: parseIceServers(process.env.SYNERGY_BROWSER_ICE_SERVERS),
      networkProxy: message.networkProxy,
      downloadDir: message.downloadDir,
      signalingTicket: message.signalingTicket,
      emitBrokerEvent: (event) => this.event(message.ownerKey, message.page.id, event),
    })
    try {
      await page.start()
      return page
    } catch (error) {
      try {
        await page.destroy()
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Browser Host page creation and cleanup both failed.")
      }
      throw error
    }
  }

  private takePages(): ManagedPage[] {
    const pages = Array.from(this.pages.values(), (entry) => entry.page)
    this.pages.clear()
    return pages
  }
}

function parseIceServers(
  value: string | undefined,
): Array<{ urls: string | string[]; username?: string; credential?: string }> {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.slice(0, 20).flatMap((entry) => {
      const result = BrowserIceServerSchema.safeParse(entry)
      return result.success ? [result.data] : []
    })
  } catch {
    return []
  }
}

async function destroyPages(pages: ManagedPage[]): Promise<void> {
  const results = await Promise.allSettled(pages.map((page) => Promise.resolve(page.destroy())))
  const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
  if (failures.length) throw new AggregateError(failures, "One or more Browser Host pages could not be closed.")
}
