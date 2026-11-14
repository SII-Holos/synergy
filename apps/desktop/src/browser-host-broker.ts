import { session } from "electron"
import WebSocket from "ws"
import { Agent as HTTPAgent } from "node:http"
import { Agent as HTTPSAgent } from "node:https"
import {
  BROWSER_PROTOCOL_VERSION,
  BrowserHostMessageSchema,
  BrowserProtocolError,
  BrowserRegistrationSecretSchema,
  type BrowserBackendResult,
  type BrowserNativeBrokerStatus,
  type BrowserHostMessage,
  type BrowserHostPageEvent,
} from "@ericsanchezok/synergy-browser-core"
import { type DesktopThemeSnapshot } from "./theme.js"
import { BrowserNativePagePool, type BrowserNativePageHandle } from "./browser-native-page-pool.js"
import { BrowserDataContexts } from "./browser-data-contexts.js"
import { browserRuntimeOwnerKey, browserRuntimePartition } from "./browser-profile.js"

export interface BrowserHostBrokerOptions {
  serverUrl: string
  token: string
  headers?: Readonly<{ authorization: string }>
  hostId?: string
  runtimeKey?: string
  nativePool?: BrowserNativePagePool
  theme: DesktopThemeSnapshot
  onStatus?(status: BrowserNativeBrokerStatus): void
  clearSavedData?(partition: string): Promise<void>
  dataContexts?: BrowserDataContexts
}

type ManagedPage = BrowserNativePageHandle
interface ManagedPageEntry {
  pageId: string
  page: ManagedPage
}

export class BrowserHostBrokerClient {
  private socket: WebSocket | null = null
  private pages = new Map<string, ManagedPageEntry>()
  private commandTails = new Map<string, Promise<void>>()
  private operations = new Set<Promise<void>>()
  private nativeLifetime = new AbortController()
  private closed = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private connectionEpoch = 0
  private disconnecting: Promise<void> | null = null
  private closing: Promise<void> | undefined
  private agent: HTTPAgent

  private options: BrowserHostBrokerOptions
  private theme: DesktopThemeSnapshot

  constructor(options: BrowserHostBrokerOptions) {
    const server = new URL(options.serverUrl)
    if (
      !["http:", "https:"].includes(server.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(server.hostname) ||
      server.username ||
      server.password
    )
      throw new Error("Native Browser requires a local Desktop server.")
    this.options = { ...options, token: BrowserRegistrationSecretSchema.parse(options.token) }
    browserRuntimeOwnerKey(options.runtimeKey, "")
    this.agent = server.protocol === "https:" ? new HTTPSAgent() : new HTTPAgent()
    this.theme = options.theme
  }

  setTheme(theme: DesktopThemeSnapshot): void {
    this.theme = theme
  }

  connect(): void {
    if (this.closed || this.socket || this.disconnecting) return
    this.nativeLifetime = new AbortController()
    this.options.onStatus?.("connecting")
    const url = new URL("/browser/host/broker", this.options.serverUrl)
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    url.searchParams.set("protocolVersion", String(BROWSER_PROTOCOL_VERSION))
    // Provenance: https://github.com/websockets/ws/blob/master/doc/ws.md#new-websocketaddress-protocols-options
    // Local adaptation: main-owned upgrade credentials require Node headers and must never follow redirects.
    const socket = new WebSocket(url, {
      headers: this.options.headers,
      followRedirects: false,
      perMessageDeflate: false,
      handshakeTimeout: 5_000,
      maxPayload: 80 * 1024 * 1024,
      agent: this.agent,
    })
    const epoch = ++this.connectionEpoch
    this.socket = socket
    socket.addEventListener("open", () => {
      if (epoch !== this.connectionEpoch || this.socket !== socket || this.closed) return
      this.send({
        type: "host.register",
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        hostId: this.options.hostId ?? `browser-host-${process.pid}`,
        token: this.options.token,
        capabilities: { native: Boolean(this.options.nativePool) },
      })
    })
    socket.addEventListener("message", (event) => {
      const operation = this.handle(event.data, epoch)
      this.operations.add(operation)
      void operation
        .catch(() => console.error("Browser Host message handling failed."))
        .finally(() => this.operations.delete(operation))
    })
    socket.addEventListener("error", () => {
      if (epoch !== this.connectionEpoch || this.socket !== socket || this.closed) return
      this.options.onStatus?.("failed")
      console.error("Browser Host broker connection failed.")
    })
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return
      this.connectionEpoch++
      this.nativeLifetime.abort()
      this.socket = null
      this.options.dataContexts?.disconnect()
      const pages = this.takePages()
      this.commandTails.clear()
      const disconnecting = this.drain(pages)
      this.disconnecting = disconnecting
      void disconnecting
        .catch((error) => console.error("Browser Host page cleanup failed after broker disconnect.", error))
        .finally(() => {
          if (this.disconnecting === disconnecting) this.disconnecting = null
          if (!this.closed) this.reconnectTimer = setTimeout(() => this.connect(), 1_000)
        })
      if (!this.closed) this.options.onStatus?.("restarting")
    })
  }

  close(): Promise<void> {
    return (this.closing ??= this.dispose())
  }

  private async dispose(): Promise<void> {
    this.closed = true
    this.connectionEpoch++
    this.nativeLifetime.abort()
    this.options.dataContexts?.disconnect()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    const socket = this.socket
    this.socket = null
    const closing = closeSocket(socket)
    const pages = this.takePages()
    this.commandTails.clear()
    const results = await Promise.allSettled([closing, this.disconnecting, this.drain(pages)])
    this.agent.destroy()
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (failures.length) throw new AggregateError(failures, "Browser Host pages did not close cleanly.")
  }

  private async drain(pages: ManagedPage[]): Promise<void> {
    const results = await Promise.allSettled([
      destroyPages(pages),
      this.options.dataContexts?.drain(),
      this.options.nativePool?.drain(this.nativeLifetime.signal),
      ...this.operations,
    ])
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (failures.length) throw new AggregateError(failures, "Browser Host native operations did not drain cleanly.")
  }

  private async handle(data: unknown, epoch: number): Promise<void> {
    if (epoch !== this.connectionEpoch) return
    if (Buffer.byteLength(String(data), "utf8") > 80 * 1024 * 1024) {
      this.socket?.close(4009, "Browser Host command is too large")
      return
    }
    let message: BrowserHostMessage
    try {
      message = BrowserHostMessageSchema.parse(JSON.parse(String(data)))
    } catch {
      this.socket?.close(4003, "Invalid Browser Host message")
      return
    }
    if (message.type === "host.registered") {
      this.options.onStatus?.("ready")
      return
    }
    if (
      message.type === "profile.data.prepare" ||
      message.type === "profile.data.release" ||
      message.type === "profile.data.revoke"
    ) {
      try {
        const contexts = this.options.dataContexts
        if (!contexts) throw new Error("Browser profile data management is unavailable.")
        if (message.type === "profile.data.prepare")
          contexts.prepare({
            ...message,
            ownerKey: browserRuntimeOwnerKey(this.options.runtimeKey, message.ownerKey),
            profile: {
              ...message.profile,
              partition: browserRuntimePartition(this.options.runtimeKey, message.profile.partition),
            },
          })
        else if (message.type === "profile.data.release")
          contexts.release(
            message.contextId,
            message.epoch,
            browserRuntimeOwnerKey(this.options.runtimeKey, message.ownerKey),
          )
        else contexts.revokeProfile(message.profileId)
        this.result(message.requestId, { type: "void" })
      } catch {
        this.failure(
          message.requestId,
          new Error("Browser profile data access could not be prepared. Reopen the dialog."),
        )
      }
      return
    }
    if (message.type === "profile.clear") {
      try {
        const partition = browserRuntimePartition(this.options.runtimeKey, message.partition)
        this.options.dataContexts?.revokeProfile(message.profileId)
        await this.options.dataContexts?.drain(partition)
        const profile = session.fromPartition(partition)
        await profile.clearStorageData()
        await profile.clearCache()
        await profile.clearAuthCache()
        await profile.closeAllConnections()
        if (message.removeSavedData) {
          if (!this.options.clearSavedData) throw new Error("Saved browser data cleanup is unavailable.")
          await this.options.clearSavedData(partition)
        }
        this.result(message.requestId, { type: "void" })
      } catch (error) {
        this.failure(message.requestId, error)
      }
      return
    }
    if (message.type !== "page.create" && message.type !== "page.close" && message.type !== "page.command") {
      this.socket?.close(4008, "Browser Host received a message for the wrong protocol role")
      return
    }
    const existingKey = message.type === "page.create" ? undefined : `${message.ownerKey}:${message.pageId}`
    const interrupt =
      existingKey &&
      this.pages.has(existingKey) &&
      (message.type === "page.close" ||
        (message.type === "page.command" &&
          (message.command.type === "stop" ||
            (["navigate", "history", "reload"].includes(message.command.type) &&
              "source" in message.command &&
              message.command.source === "user"))))
    if (interrupt || (message.type === "page.command" && message.command.type === "dialog.respond")) {
      await this.dispatch(message, epoch)
      return
    }
    const key = `${message.ownerKey}:${message.type === "page.create" ? message.page.id : message.pageId}`
    const previous = this.commandTails.get(key) ?? Promise.resolve()
    const operation = previous.then(() => this.dispatch(message, epoch))
    this.commandTails.set(key, operation)
    try {
      await operation
    } finally {
      if (this.commandTails.get(key) === operation) this.commandTails.delete(key)
    }
  }

  private async dispatch(
    message: Extract<BrowserHostMessage, { type: "page.create" | "page.close" | "page.command" }>,
    epoch: number,
  ): Promise<void> {
    if (epoch !== this.connectionEpoch) return
    const key = `${message.ownerKey}:${message.type === "page.create" ? message.page.id : message.pageId}`
    if (message.type === "page.create") {
      try {
        if (this.pages.has(key)) throw new Error("Browser page already exists.")
        const page = await this.createNativePage(message, epoch)
        if (epoch !== this.connectionEpoch || this.socket?.readyState !== WebSocket.OPEN) {
          await page.destroy()
          return
        }
        this.pages.set(key, { pageId: message.page.id, page })
        this.result(message.requestId, { type: "page", page: page.state() })
      } catch (error) {
        this.failure(message.requestId, error)
      }
      return
    }
    if (message.type === "page.close") {
      const entry = this.pages.get(key)
      if (!entry || entry.pageId !== message.pageId) {
        this.failure(message.requestId, new Error("Browser Host page was not found."))
        return
      }
      try {
        await entry.page.destroy()
        this.pages.delete(key)
        this.result(message.requestId, { type: "void" })
      } catch (error) {
        if (!entry.page.isAlive()) {
          this.pages.delete(key)
          console.error("Browser Host page closed with cleanup errors.", error)
          this.result(message.requestId, { type: "void" })
          return
        }
        this.failure(message.requestId, error)
      }
      return
    }
    if (message.type !== "page.command") return
    const entry = this.pages.get(key)
    if (!entry || entry.pageId !== message.pageId) {
      this.failure(message.requestId, new Error("Browser Host page was not found."))
      return
    }
    try {
      this.result(message.requestId, await entry.page.execute(message.command, message.agentSessionID))
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
    if (event.type === "page.closed") this.pages.delete(`${ownerKey}:${pageId}`)
    this.send({ type: "page.event", protocolVersion: BROWSER_PROTOCOL_VERSION, ownerKey, pageId, event })
  }

  private async createNativePage(
    message: Extract<BrowserHostMessage, { type: "page.create" }>,
    epoch: number,
  ): Promise<BrowserNativePageHandle> {
    if (!this.options.nativePool) throw new Error("This Browser Host has no native page capability.")
    return this.options.nativePool.create({
      ownerKey: browserRuntimeOwnerKey(this.options.runtimeKey, message.ownerKey),
      signal: this.nativeLifetime.signal,
      requestId: message.requestId,
      page: message.page,
      profile: {
        ...message.profile,
        partition: browserRuntimePartition(this.options.runtimeKey, message.profile.partition),
      },
      onPopup: (input, page) => {
        if (epoch !== this.connectionEpoch || this.closed) {
          void page.destroy().catch(() => console.error("Retired Browser popup cleanup failed."))
          return
        }
        const key = `${message.ownerKey}:${input.page.id}`
        this.pages.set(key, { pageId: input.page.id, page })
        this.send({
          type: "page.opened",
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          ownerKey: message.ownerKey,
          openerId: input.openerId,
          page: input.page,
        })
      },
      networkProxy: message.networkProxy,
      downloadDir: message.downloadDir,
      emit: (event) => {
        if (epoch === this.connectionEpoch && !this.closed)
          this.event(message.ownerKey, "page" in event ? event.page.id : event.pageId, event)
      },
    })
  }

  private takePages(): ManagedPage[] {
    const pages = Array.from(this.pages.values(), (entry) => entry.page)
    this.pages.clear()
    return pages
  }
}

async function closeSocket(socket: WebSocket | null): Promise<void> {
  if (!socket || socket.readyState === WebSocket.CLOSED) return
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()))
  const timeout = setTimeout(() => socket.terminate(), 1_000)
  try {
    socket.close()
    await closed
  } finally {
    clearTimeout(timeout)
  }
}

async function destroyPages(pages: ManagedPage[]): Promise<void> {
  const results = await Promise.allSettled(pages.map((page) => Promise.resolve(page.destroy())))
  const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
  if (failures.length) throw new AggregateError(failures, "One or more Browser Host pages could not be closed.")
}
