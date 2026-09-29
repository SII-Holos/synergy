import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { randomBytes, timingSafeEqual } from "node:crypto"
import {
  BROWSER_ACTION_SETTLE_TIMEOUT_MS,
  BROWSER_BEST_EFFORT_SNAPSHOT_TIMEOUT_MS,
  BROWSER_NAVIGATION_SETTLE_TIMEOUT_MS,
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
} from "@ericsanchezok/synergy-browser-core"
import { BrowserProfiles } from "./profiles.js"
import { BrowserOwner } from "./owner.js"
import { BrowserNetworkGateway } from "./network-gateway.js"
import { BrowserStorage } from "./storage.js"
import { BrowserDownloads } from "./downloads.js"
import { BrowserEvent } from "./event.js"
import { ObservabilityBrowserTelemetry } from "@ericsanchezok/synergy-harness/observability/browser-metrics"

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

const runtimeState = RuntimeContext.state(() => ({
  connection: null as Connection | null,
  requestSequence: 0,
  profiles: new Map<string, string>(),
  popupListeners: new Map<string, (input: { id: string; url: string; openerId: string }) => Promise<unknown>>(),
  bufferedEvents: new Map<string, BrowserHostPageEvent[]>(),
  registrationSecret: BrowserRegistrationSecretSchema.parse(
    RuntimeContext.current().host.env.SYNERGY_BROWSER_HOST_REGISTRATION_SECRET || randomBytes(32).toString("hex"),
  ),
  preferences: new Map<
    string,
    { owner: BrowserOwner.Info; routeDirectory: string; presentation: BrowserPresentationKind }
  >(),
  eventListeners: new Map<string, Set<(event: BrowserHostPageEvent) => void>>(),
  activityListeners: new Set<(hasPages: boolean) => void>(),
}))

const MAX_PENDING_REQUESTS = 64
const MAX_EVENTS_PER_SECOND = 500

export namespace BrowserBroker {
  export function secret(): string {
    const instanceState = runtimeState()

    return instanceState.registrationSecret
  }

  export function capabilities(): BrowserPresentationCapabilities {
    const instanceState = runtimeState()

    return instanceState.connection?.capabilities ?? { native: false }
  }

  export function ready(kind?: BrowserPresentationKind): boolean {
    const instanceState = runtimeState()

    if (!instanceState.connection) return false
    return kind ? instanceState.connection.capabilities[kind] : true
  }

  export function hasPage(owner: BrowserOwner.Info, pageId: string): boolean {
    const instanceState = runtimeState()

    return instanceState.connection?.pages.has(pageKey(owner, pageId)) ?? false
  }
  export function onActivity(listener: (hasPages: boolean) => void): () => void {
    const instanceState = runtimeState()

    instanceState.activityListeners.add(listener)
    return () => {
      const instanceState = runtimeState()
      return instanceState.activityListeners.delete(listener)
    }
  }

  export function publishHostStatus(status: BrowserHostStatus): void {
    notifyHostStatus(status)
  }

  export function prepare(
    owner: BrowserOwner.Info,
    routeDirectory: string,
    presentation: BrowserPresentationKind,
  ): void {
    const instanceState = runtimeState()

    instanceState.preferences.set(BrowserOwner.key(owner), { owner, routeDirectory, presentation })
  }

  export function preference(
    owner: BrowserOwner.Info,
  ): { routeDirectory: string; presentation: BrowserPresentationKind } | null {
    const instanceState = runtimeState()

    const explicit = instanceState.preferences.get(BrowserOwner.key(owner))
    if (explicit && ready(explicit.presentation)) {
      return { routeDirectory: explicit.routeDirectory, presentation: explicit.presentation }
    }
    if (ready("native")) return { routeDirectory: owner.scopeID, presentation: "native" }
    return null
  }

  export function attach(socket: BrowserBrokerSocket, input: unknown): void {
    const instanceState = runtimeState()

    const parsed = BrowserHostMessageSchema.safeParse(input)
    if (!parsed.success) {
      socket.close(1008, "Invalid Browser Host registration")
      throw new Error("Invalid Browser Host registration message.")
    }
    const message = parsed.data
    if (message.type !== "host.register") throw new Error("First Browser Host broker message must register the host.")
    if (!secureEqual(message.token, instanceState.registrationSecret)) {
      socket.close(1008, "Invalid Browser Host registration secret")
      throw new Error("Invalid Browser Host registration secret")
    }
    if (!message.capabilities.native) {
      socket.close(1008, "Browser Host registered no capabilities")
      throw new Error("Browser Host must register at least one presentation capability.")
    }
    if (instanceState.connection) {
      socket.close(1013, "Browser Host broker is already registered")
      throw new Error("A Browser Host broker is already registered for this server.")
    }
    instanceState.connection = {
      hostId: message.hostId,
      socket,
      capabilities: message.capabilities,
      pending: new Map(),
      pages: new Set(),
      eventWindowStartedAt: Date.now(),
      eventCount: 0,
    }
    notifyHostStatus("ready")
    ObservabilityBrowserTelemetry.recordHostStatus("ready")
    notifyActivity()
    send({ type: "host.registered", protocolVersion: BROWSER_PROTOCOL_VERSION, hostId: message.hostId })
  }

  export function detach(socket: BrowserBrokerSocket): void {
    const instanceState = runtimeState()

    if (instanceState.connection?.socket !== socket) return
    disconnect(instanceState.connection, new Error("Browser Host broker disconnected."))
    instanceState.connection = null
    notifyHostStatus("restarting")
    ObservabilityBrowserTelemetry.recordHostStatus("restarting")
    notifyActivity()
  }

  export function handle(socket: BrowserBrokerSocket, input: unknown): void {
    const instanceState = runtimeState()

    if (instanceState.connection?.socket !== socket) throw new Error("Browser Host broker is not registered.")
    const message = BrowserHostMessageSchema.parse(input)
    if (message.type === "page.opened") {
      const active = instanceState.connection
      const parentKey = `${message.ownerKey}:${message.openerId}`
      const key = `${message.ownerKey}:${message.page.id}`
      const profileId = instanceState.profiles.get(parentKey)
      const preference = instanceState.preferences.get(message.ownerKey)
      const listener = instanceState.popupListeners.get(message.ownerKey)
      if (
        !active.pages.has(parentKey) ||
        !profileId ||
        !preference ||
        !listener ||
        active.pages.has(key) ||
        active.pages.size >= 64 ||
        [...active.pages].filter((key) => key.startsWith(`${message.ownerKey}:`)).length >= 16
      ) {
        void request({
          type: "page.close",
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          requestId: nextRequestId(),
          ownerKey: message.ownerKey,
          pageId: message.page.id,
        }).catch(() => undefined)
        return
      }
      active.pages.add(key)
      instanceState.profiles.set(key, profileId)
      instanceState.bufferedEvents.set(key, [{ type: "page.updated", page: message.page }])
      void listener({ id: message.page.id, url: message.page.url, openerId: message.openerId })
        .catch(() => closePage(preference.owner, message.page.id))
        .catch(() => undefined)
      return
    }
    if (message.type === "page.event") {
      const now = Date.now()
      if (now - instanceState.connection.eventWindowStartedAt >= 1_000) {
        instanceState.connection.eventWindowStartedAt = now
        instanceState.connection.eventCount = 0
      }
      instanceState.connection.eventCount++
      if (instanceState.connection.eventCount > MAX_EVENTS_PER_SECOND) {
        instanceState.connection.socket.close(1008, "Browser Host event rate exceeded")
        return
      }
      const key = `${message.ownerKey}:${message.pageId}`
      if (!instanceState.connection.pages.has(key)) {
        instanceState.connection.socket.close(1008, "Browser Host emitted an event for an unknown page")
        return
      }
      if (eventPageId(message.event) !== message.pageId) {
        instanceState.connection.socket.close(1008, "Browser Host event page does not match its envelope")
        return
      }
      if (message.event.type === "host.status") {
        const preference = instanceState.preferences.get(message.ownerKey)
        if (preference) {
          BrowserEvent.publish(preference.owner, {
            type: "host.status",
            pageId: message.pageId,
            status: message.event.status,
          })
          ObservabilityBrowserTelemetry.recordHostStatus(message.event.status, preference.owner)
        }
      }
      const buffered = instanceState.bufferedEvents.get(key)
      if (buffered && buffered.length < 256) buffered.push(message.event)
      for (const listener of instanceState.eventListeners.get(key) ?? []) listener(message.event)
      if (message.event.type === "page.closed") releasePage(instanceState.connection, key)
      return
    }
    if (message.type !== "page.result") {
      instanceState.connection.socket.close(1008, "Browser Host sent a message for the wrong protocol role")
      return
    }
    const pending = instanceState.connection.pending.get(message.requestId)
    if (!pending) return
    instanceState.connection.pending.delete(message.requestId)
    clearTimeout(pending.timer)
    if (message.error) {
      pending.reject(new BrowserProtocolError(message.error))
      return
    }
    const resultPage = message.result ? resultPageId(message.result) : undefined
    if (resultPage && resultPage !== pending.pageId) {
      pending.reject(new Error("Browser Host result page does not match its request."))
      instanceState.connection.socket.close(1008, "Browser Host result crossed a page boundary")
      return
    }
    pending.resolve(message.result ?? { type: "void" })
  }

  export async function createPage(input: {
    owner: BrowserOwner.Info
    routeDirectory: string
    presentation: BrowserPresentationKind
    pageId: string
    profile: BrowserProfiles.Stored
    url?: string
  }): Promise<BrowserBackendResult> {
    const instanceState = runtimeState()

    if (!ready(input.presentation)) throw new Error(`Browser Host does not support ${input.presentation} presentation.`)
    const active = instanceState.connection
    if (!active) throw new Error("Browser Host broker is unavailable.")
    const ownerKey = BrowserOwner.key(input.owner)
    if (active.pages.size >= 64)
      throw new BrowserProtocolError({
        code: "browser_desktop_page_limit",
        message: "Close a page before opening another (64 active pages per Desktop).",
        retryable: false,
      })
    if (active.pages.has(pageKey(input.owner, input.pageId))) throw new Error("Browser page already exists.")
    prepare(input.owner, input.routeDirectory, "native")
    const reservedPageKey = pageKey(input.owner, input.pageId)
    active.pages.add(reservedPageKey)
    instanceState.profiles.set(reservedPageKey, input.profile.id)
    notifyActivity()
    let createSent = false
    try {
      await BrowserStorage.ensureOwnerDirs(input.owner)
      const networkProxy = await BrowserNetworkGateway.proxyFor(input.profile.id)
      const downloadDir = await BrowserDownloads.managedDirectory(input.owner)
      createSent = true
      const result = await request({
        type: "page.create",
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        requestId: nextRequestId(),
        ownerKey: BrowserOwner.key(input.owner),
        owner: {
          mode: input.owner.mode,
          scopeID: input.owner.scopeID,
          sessionID: input.owner.sessionID,
          directory: input.owner.directory,
        },
        routeDirectory: input.routeDirectory,
        presentation: input.presentation,
        page: {
          id: input.pageId,
          url: input.url ?? "about:blank",
          title: "",
          isLoading: false,
          lastActiveAt: null,
        },
        profile: { id: input.profile.id, partition: input.profile.partition, revision: input.profile.revision },
        networkProxy,
        downloadDir,
      })
      return result
    } catch (error) {
      const timedOut =
        createSent &&
        instanceState.connection === active &&
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
            const instanceState = runtimeState()

            if (instanceState.connection === active) releasePage(active, reservedPageKey)

            notifyActivity()
            ObservabilityBrowserTelemetry.recordResourceCleanup(input.owner, "ok")
          })
          .catch(() => {
            active.socket.close(1011, "Browser Host page creation could not be cleaned up")
            ObservabilityBrowserTelemetry.recordResourceCleanup(input.owner, "failed")
          })
      } else {
        releasePage(active, reservedPageKey)

        notifyActivity()
        ObservabilityBrowserTelemetry.recordResourceCleanup(input.owner, "ok")
      }
      throw error
    }
  }

  export async function clearProfile(profile: BrowserProfiles.Stored, removeSavedData = false): Promise<void> {
    await request({
      type: "profile.clear",
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      requestId: nextRequestId(),
      profileId: profile.id,
      partition: profile.partition,
      ...(removeSavedData ? { removeSavedData: true } : {}),
    })
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
    const instanceState = runtimeState()

    await request({
      type: "page.close",
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      requestId: nextRequestId(),
      ownerKey: BrowserOwner.key(owner),
      pageId,
    })
    if (instanceState.connection) releasePage(instanceState.connection, pageKey(owner, pageId))

    notifyActivity()
    ObservabilityBrowserTelemetry.recordResourceCleanup(owner, "ok")
  }

  export function subscribe(
    owner: BrowserOwner.Info,
    pageId: string,
    listener: (event: BrowserHostPageEvent) => void,
  ): () => void {
    const instanceState = runtimeState()

    const key = pageKey(owner, pageId)
    const listeners = instanceState.eventListeners.get(key) ?? new Set()
    listeners.add(listener)
    instanceState.eventListeners.set(key, listeners)
    for (const event of instanceState.bufferedEvents.get(key) ?? []) listener(event)
    instanceState.bufferedEvents.delete(key)
    return () => {
      const instanceState = runtimeState()

      listeners.delete(listener)
      if (listeners.size === 0) instanceState.eventListeners.delete(key)
    }
  }

  export function onPopup(
    owner: BrowserOwner.Info,
    listener: (input: { id: string; url: string; openerId: string }) => Promise<unknown>,
  ): void {
    runtimeState().popupListeners.set(BrowserOwner.key(owner), listener)
  }

  export function release(owner: BrowserOwner.Info): void {
    const instanceState = runtimeState()

    const ownerKey = BrowserOwner.key(owner)
    instanceState.preferences.delete(ownerKey)
    instanceState.popupListeners.delete(ownerKey)

    for (const key of instanceState.eventListeners.keys()) {
      if (key.startsWith(`${ownerKey}:`)) instanceState.eventListeners.delete(key)
    }
  }

  export function resetForTest(): void {
    const instanceState = runtimeState()

    if (instanceState.connection) {
      disconnect(instanceState.connection, new Error("Browser Host broker test state was reset."))
      instanceState.connection.socket.close()
    }
    instanceState.connection = null
    instanceState.requestSequence = 0
    instanceState.preferences.clear()
    instanceState.eventListeners.clear()
    instanceState.activityListeners.clear()
  }
}

function releasePage(connection: Connection, key: string) {
  const state = runtimeState()
  connection.pages.delete(key)
  const profileId = state.profiles.get(key)
  state.profiles.delete(key)
  state.bufferedEvents.delete(key)
  if (profileId && ![...state.profiles.values()].includes(profileId)) {
    BrowserNetworkGateway.revoke(profileId)
    BrowserProfiles.releaseTemporary(profileId)
  }
}

function notifyActivity(): void {
  const instanceState = runtimeState()

  const hasPages = Boolean(instanceState.connection?.pages.size)
  for (const listener of instanceState.activityListeners) listener(hasPages)
}

function notifyHostStatus(status: BrowserHostStatus): void {
  const instanceState = runtimeState()

  for (const preference of instanceState.preferences.values()) {
    BrowserEvent.publish(preference.owner, { type: "host.status", status })
  }
}

function request(
  message: Extract<BrowserHostMessage, { type: "page.create" | "page.command" | "page.close" | "profile.clear" }>,
): Promise<BrowserBackendResult> {
  const instanceState = runtimeState()

  const active = instanceState.connection
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
      ObservabilityBrowserTelemetry.recordBrokerTimeout(
        message.type,
        message.type === "page.command" ? message.command.type : undefined,
        telemetryOwner(message),
      )
      reject(
        new BrowserProtocolError({
          code: "browser_host_timeout",
          message: `Browser Host request timed out: ${message.type}`,
          retryable: true,
          pageId:
            message.type === "profile.clear"
              ? message.profileId
              : "pageId" in message
                ? message.pageId
                : message.page.id,
        }),
      )
    }, requestTimeout(message))
    active.pending.set(message.requestId, {
      resolve,
      reject,
      timer,
      pageId:
        message.type === "profile.clear" ? message.profileId : "pageId" in message ? message.pageId : message.page.id,
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
  message: Extract<BrowserHostMessage, { type: "page.create" | "page.command" | "page.close" | "profile.clear" }>,
): number {
  if (message.type !== "page.command") return 35_000
  const command = message.command
  if (command.type === "evaluate") return Math.min(125_000, (command.timeoutMs ?? 30_000) + 5_000)
  if (command.type === "wait") return command.timeoutMs + 5_000
  if (command.type === "action") {
    const settleMs = command.action.settleTimeoutMs ?? BROWSER_ACTION_SETTLE_TIMEOUT_MS
    // Include the post-settle best-effort snapshot budget so the controller's
    // settle + snapshot work cannot outrun the broker deadline and turn a
    // successful action into a spurious unknown-outcome timeout.
    return (command.action.timeoutMs ?? 5_000) + settleMs + BROWSER_BEST_EFFORT_SNAPSHOT_TIMEOUT_MS + 5_000
  }
  if (command.type === "navigate" || command.type === "history" || command.type === "reload") {
    const settleMs = command.settleTimeoutMs ?? BROWSER_NAVIGATION_SETTLE_TIMEOUT_MS
    return settleMs + 10_000
  }
  return 35_000
}

function disconnect(active: Connection, error: Error): void {
  const instanceState = runtimeState()

  for (const pending of active.pending.values()) {
    clearTimeout(pending.timer)
    pending.reject(error)
  }
  active.pending.clear()
  for (const preference of instanceState.preferences.values()) {
    ObservabilityBrowserTelemetry.recordHostDisconnected(preference.owner)
  }
  for (const key of active.pages) {
    const separator = key.lastIndexOf(":")
    const ownerKey = separator > 0 ? key.slice(0, separator) : undefined
    const pageId = separator > 0 ? key.slice(separator + 1) : undefined
    const listeners = instanceState.eventListeners.get(key)
    const preference = ownerKey ? instanceState.preferences.get(ownerKey) : undefined
    if (pageId && preference) {
      BrowserEvent.publish(preference.owner, { type: "host.status", pageId, status: "restarting" })
    }
    if (pageId && listeners) {
      for (const listener of listeners) {
        listener({ type: "host.status", pageId, status: "restarting" })
        listener({ type: "page.error", pageId, message: error.message })
      }
    }
  }
  for (const key of [...active.pages]) releasePage(active, key)
}

function send(message: BrowserHostMessage): void {
  const instanceState = runtimeState()

  instanceState.connection?.socket.send(JSON.stringify(message))
}

function nextRequestId(): string {
  const instanceState = runtimeState()

  return `broker-${++instanceState.requestSequence}-${crypto.randomUUID()}`
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

function telemetryOwner(
  message: Extract<BrowserHostMessage, { type: "page.create" | "page.command" | "page.close" | "profile.clear" }>,
): BrowserOwner.Info | undefined {
  const instanceState = runtimeState()

  return "ownerKey" in message ? instanceState.preferences.get(message.ownerKey)?.owner : undefined
}
