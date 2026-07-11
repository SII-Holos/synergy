import { randomBytes, timingSafeEqual } from "node:crypto"
import {
  BROWSER_PROTOCOL_VERSION,
  BrowserBackendCommandSchema,
  BrowserHostMessageSchema,
  BrowserProtocolError,
  BrowserRegistrationSecretSchema,
  type BrowserBackendCommand,
  type BrowserBackendResult,
  type BrowserHostStatus,
  type BrowserHostMessage,
  type BrowserHostPageEvent,
  type BrowserPresentationCapabilities,
  type BrowserPresentationKind,
} from "@ericsanchezok/synergy-browser"
import { BrowserOwner } from "./owner.js"
import { BrowserNetworkGateway } from "./network-gateway.js"
import { BrowserStorage } from "./storage.js"
import { BrowserTicket } from "./ticket.js"
import { BrowserDownloads } from "./downloads.js"
import { BrowserEvent } from "./event.js"

export interface BrowserBrokerSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
}

interface PendingRequest {
  resolve(result: BrowserBackendResult): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
  pageId: string
}

interface Connection {
  hostId: string
  socket: BrowserBrokerSocket
  capabilities: BrowserPresentationCapabilities
  pending: Map<string, PendingRequest>
  pages: Set<string>
  eventWindowStartedAt: number
  eventCount: number
}

let connection: Connection | null = null
let requestSequence = 0
const registrationSecret = BrowserRegistrationSecretSchema.parse(
  process.env.SYNERGY_BROWSER_HOST_REGISTRATION_SECRET || randomBytes(32).toString("hex"),
)
const preferences = new Map<
  string,
  { owner: BrowserOwner.Info; routeDirectory: string; presentation: BrowserPresentationKind }
>()
const eventListeners = new Map<string, Set<(event: BrowserHostPageEvent) => void>>()
const activityListeners = new Set<(hasPages: boolean) => void>()
const MAX_PENDING_REQUESTS = 64
const MAX_EVENTS_PER_SECOND = 500

export namespace BrowserBroker {
  export function secret(): string {
    return registrationSecret
  }

  export function capabilities(): BrowserPresentationCapabilities {
    return connection?.capabilities ?? { native: false, webrtc: false }
  }

  export function ready(kind?: BrowserPresentationKind): boolean {
    if (!connection) return false
    return kind ? connection.capabilities[kind] : true
  }

  export function hasPage(owner: BrowserOwner.Info, pageId: string): boolean {
    return connection?.pages.has(pageKey(owner, pageId)) ?? false
  }

  export function onActivity(listener: (hasPages: boolean) => void): () => void {
    activityListeners.add(listener)
    return () => activityListeners.delete(listener)
  }

  export function publishHostStatus(status: BrowserHostStatus): void {
    notifyHostStatus(status)
  }

  export function prepare(
    owner: BrowserOwner.Info,
    routeDirectory: string,
    presentation: BrowserPresentationKind,
  ): void {
    preferences.set(BrowserOwner.key(owner), { owner, routeDirectory, presentation })
  }

  export function preference(
    owner: BrowserOwner.Info,
  ): { routeDirectory: string; presentation: BrowserPresentationKind } | null {
    const explicit = preferences.get(BrowserOwner.key(owner))
    if (explicit && ready(explicit.presentation)) {
      return { routeDirectory: explicit.routeDirectory, presentation: explicit.presentation }
    }
    if (ready("native")) return { routeDirectory: owner.scopeID, presentation: "native" }
    if (ready("webrtc")) return { routeDirectory: owner.scopeID, presentation: "webrtc" }
    return null
  }

  export function attach(socket: BrowserBrokerSocket, input: unknown): void {
    const parsed = BrowserHostMessageSchema.safeParse(input)
    if (!parsed.success) {
      socket.close(1008, "Invalid Browser Host registration")
      throw new Error("Invalid Browser Host registration message.")
    }
    const message = parsed.data
    if (message.type !== "host.register") throw new Error("First Browser Host broker message must register the host.")
    if (!secureEqual(message.token, registrationSecret)) {
      socket.close(1008, "Invalid Browser Host registration secret")
      throw new Error("Invalid Browser Host registration secret")
    }
    if (!message.capabilities.native && !message.capabilities.webrtc) {
      socket.close(1008, "Browser Host registered no capabilities")
      throw new Error("Browser Host must register at least one presentation capability.")
    }
    if (connection) {
      socket.close(1013, "Browser Host broker is already registered")
      throw new Error("A Browser Host broker is already registered for this server.")
    }
    connection = {
      hostId: message.hostId,
      socket,
      capabilities: message.capabilities,
      pending: new Map(),
      pages: new Set(),
      eventWindowStartedAt: Date.now(),
      eventCount: 0,
    }
    notifyHostStatus("ready")
    notifyActivity()
    send({ type: "host.registered", protocolVersion: BROWSER_PROTOCOL_VERSION, hostId: message.hostId })
  }

  export function detach(socket: BrowserBrokerSocket): void {
    if (connection?.socket !== socket) return
    disconnect(connection, new Error("Browser Host broker disconnected."))
    connection = null
    notifyHostStatus("restarting")
    notifyActivity()
  }

  export function handle(socket: BrowserBrokerSocket, input: unknown): void {
    if (connection?.socket !== socket) throw new Error("Browser Host broker is not registered.")
    const message = BrowserHostMessageSchema.parse(input)
    if (message.type === "page.event") {
      const now = Date.now()
      if (now - connection.eventWindowStartedAt >= 1_000) {
        connection.eventWindowStartedAt = now
        connection.eventCount = 0
      }
      connection.eventCount++
      if (connection.eventCount > MAX_EVENTS_PER_SECOND) {
        connection.socket.close(1008, "Browser Host event rate exceeded")
        return
      }
      const key = `${message.ownerKey}:${message.pageId}`
      if (!connection.pages.has(key)) {
        connection.socket.close(1008, "Browser Host emitted an event for an unknown page")
        return
      }
      if (eventPageId(message.event) !== message.pageId) {
        connection.socket.close(1008, "Browser Host event page does not match its envelope")
        return
      }
      for (const listener of eventListeners.get(key) ?? []) listener(message.event)
      return
    }
    if (message.type !== "page.result") {
      connection.socket.close(1008, "Browser Host sent a message for the wrong protocol role")
      return
    }
    const pending = connection.pending.get(message.requestId)
    if (!pending) return
    connection.pending.delete(message.requestId)
    clearTimeout(pending.timer)
    if (message.error) {
      pending.reject(new BrowserProtocolError(message.error))
      return
    }
    const resultPage = message.result ? resultPageId(message.result) : undefined
    if (resultPage && resultPage !== pending.pageId) {
      pending.reject(new Error("Browser Host result page does not match its request."))
      connection.socket.close(1008, "Browser Host result crossed a page boundary")
      return
    }
    pending.resolve(message.result ?? { type: "void" })
  }

  export async function createPage(input: {
    owner: BrowserOwner.Info
    routeDirectory: string
    presentation: BrowserPresentationKind
    pageId: string
    url?: string
  }): Promise<BrowserBackendResult> {
    if (!ready(input.presentation)) throw new Error(`Browser Host does not support ${input.presentation} presentation.`)
    const active = connection
    if (!active) throw new Error("Browser Host broker is unavailable.")
    const ownerKey = BrowserOwner.key(input.owner)
    if (Array.from(active.pages).some((key) => key.startsWith(`${ownerKey}:`))) {
      throw new BrowserProtocolError({
        code: "browser_owner_page_exists",
        message: "Browser owner already has an active Host page.",
        retryable: false,
        pageId: input.pageId,
      })
    }
    const reservedPageKey = pageKey(input.owner, input.pageId)
    active.pages.add(reservedPageKey)
    notifyActivity()
    let createSent = false
    try {
      await BrowserStorage.ensureOwnerDirs(input.owner)
      const networkProxy = await BrowserNetworkGateway.proxyFor(input.owner)
      const downloadDir = await BrowserDownloads.managedDirectory(input.owner)
      const signalingTicket =
        input.presentation === "webrtc" ? BrowserTicket.issue(input.owner, input.pageId, "host") : null
      createSent = true
      const result = await request({
        type: "page.create",
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        requestId: nextRequestId(),
        ownerKey: BrowserOwner.key(input.owner),
        owner: input.owner,
        routeDirectory: input.routeDirectory,
        presentation: input.presentation,
        page: {
          id: input.pageId,
          url: input.url ?? "about:blank",
          title: "",
          isLoading: false,
          lastActiveAt: null,
        },
        networkProxy,
        downloadDir,
        ...(signalingTicket ? { signalingTicket: signalingTicket.ticket } : {}),
      })
      return result
    } catch (error) {
      const timedOut =
        createSent &&
        connection === active &&
        error instanceof BrowserProtocolError &&
        error.code === "browser_host_timeout"
      if (timedOut) {
        void request({
          type: "page.close",
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          requestId: nextRequestId(),
          ownerKey,
          pageId: input.pageId,
        })
          .then(() => {
            if (connection === active) active.pages.delete(reservedPageKey)
            BrowserTicket.revoke(input.owner, input.pageId)
            notifyActivity()
          })
          .catch(() => active.socket.close(1011, "Browser Host page creation could not be cleaned up"))
      } else {
        active.pages.delete(reservedPageKey)
        BrowserTicket.revoke(input.owner, input.pageId)
        notifyActivity()
      }
      throw error
    }
  }

  export async function command(
    owner: BrowserOwner.Info,
    pageId: string,
    command: BrowserBackendCommand,
  ): Promise<BrowserBackendResult> {
    return request({
      type: "page.command",
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      requestId: nextRequestId(),
      ownerKey: BrowserOwner.key(owner),
      pageId,
      command: BrowserBackendCommandSchema.parse(command),
    })
  }

  export async function closePage(owner: BrowserOwner.Info, pageId: string): Promise<void> {
    await request({
      type: "page.close",
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      requestId: nextRequestId(),
      ownerKey: BrowserOwner.key(owner),
      pageId,
    })
    connection?.pages.delete(pageKey(owner, pageId))
    BrowserTicket.revoke(owner, pageId)
    notifyActivity()
  }

  export function subscribe(
    owner: BrowserOwner.Info,
    pageId: string,
    listener: (event: BrowserHostPageEvent) => void,
  ): () => void {
    const key = pageKey(owner, pageId)
    const listeners = eventListeners.get(key) ?? new Set()
    listeners.add(listener)
    eventListeners.set(key, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) eventListeners.delete(key)
    }
  }

  export function release(owner: BrowserOwner.Info): void {
    const ownerKey = BrowserOwner.key(owner)
    preferences.delete(ownerKey)
    BrowserTicket.revoke(owner)
    for (const key of eventListeners.keys()) {
      if (key.startsWith(`${ownerKey}:`)) eventListeners.delete(key)
    }
  }

  export function resetForTest(): void {
    if (connection) {
      disconnect(connection, new Error("Browser Host broker test state was reset."))
      connection.socket.close()
    }
    connection = null
    requestSequence = 0
    preferences.clear()
    eventListeners.clear()
    activityListeners.clear()
  }
}

function notifyActivity(): void {
  const hasPages = Boolean(connection?.pages.size)
  for (const listener of activityListeners) listener(hasPages)
}

function notifyHostStatus(status: BrowserHostStatus): void {
  for (const preference of preferences.values()) {
    BrowserEvent.publish(preference.owner, { type: "host.status", status })
  }
}

function request(
  message: Extract<BrowserHostMessage, { type: "page.create" | "page.command" | "page.close" }>,
): Promise<BrowserBackendResult> {
  const active = connection
  if (!active) throw new Error("Browser Host broker is unavailable.")
  if (active.pending.size >= MAX_PENDING_REQUESTS) {
    throw new BrowserProtocolError({
      code: "browser_host_concurrency_exceeded",
      message: `Browser Host already has ${MAX_PENDING_REQUESTS} commands in flight.`,
      retryable: true,
    })
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      active.pending.delete(message.requestId)
      reject(
        new BrowserProtocolError({
          code: "browser_host_timeout",
          message: `Browser Host request timed out: ${message.type}`,
          retryable: true,
          pageId: "pageId" in message ? message.pageId : message.page.id,
        }),
      )
    }, requestTimeout(message))
    active.pending.set(message.requestId, {
      resolve,
      reject,
      timer,
      pageId: "pageId" in message ? message.pageId : message.page.id,
    })
    try {
      active.socket.send(JSON.stringify(message))
    } catch (error) {
      clearTimeout(timer)
      active.pending.delete(message.requestId)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

function requestTimeout(
  message: Extract<BrowserHostMessage, { type: "page.create" | "page.command" | "page.close" }>,
): number {
  if (message.type !== "page.command") return 35_000
  const command = message.command
  if (command.type === "evaluate") return Math.min(125_000, (command.timeoutMs ?? 30_000) + 5_000)
  if (command.type === "wait") return command.timeoutMs + 5_000
  if (command.type === "action") return (command.action.timeoutMs ?? 5_000) + 5_000
  return 35_000
}

function disconnect(active: Connection, error: Error): void {
  for (const pending of active.pending.values()) {
    clearTimeout(pending.timer)
    pending.reject(error)
  }
  active.pending.clear()
  for (const key of active.pages) {
    const separator = key.lastIndexOf(":")
    const listeners = eventListeners.get(key)
    if (separator > 0 && listeners) {
      const pageId = key.slice(separator + 1)
      for (const listener of listeners) listener({ type: "page.error", pageId, message: error.message })
    }
  }
  active.pages.clear()
}

function send(message: BrowserHostMessage): void {
  connection?.socket.send(JSON.stringify(message))
}

function nextRequestId(): string {
  return `broker-${++requestSequence}-${crypto.randomUUID()}`
}

function pageKey(owner: BrowserOwner.Info, pageId: string): string {
  return `${BrowserOwner.key(owner)}:${pageId}`
}

function eventPageId(event: BrowserHostPageEvent): string {
  return event.type === "page.updated" || event.type === "page.loaded" ? event.page.id : event.pageId
}

function resultPageId(result: BrowserBackendResult): string | undefined {
  if (result.type === "page" || result.type === "navigation") return result.page.id
  if (
    result.type === "snapshot" ||
    result.type === "action" ||
    result.type === "wait" ||
    result.type === "evaluation" ||
    result.type === "screenshot" ||
    result.type === "data"
  )
    return result.pageId
  return undefined
}

function secureEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}
