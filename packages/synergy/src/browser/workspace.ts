import type { BrowserPresentationSelection } from "@ericsanchezok/synergy-util/browser-protocol"
import { Log } from "../util/log"
import { BrowserControl } from "./control.js"
import { BrowserElectronHostProcess } from "./electron-host-process.js"
import { BrowserHost } from "./host.js"
import { BrowserHostControl } from "./host-control.js"
import { BrowserOwner } from "./owner.js"
import type { BrowserSession } from "./types.js"

const log = Log.create({ service: "browser.workspace" })

export namespace BrowserWorkspace {
  export interface State {
    directory: string
    owner: BrowserOwner.Info
    presentation: BrowserPresentationSelection
    client: "web" | "desktop"
  }

  export interface ControlRequest {
    command: BrowserControl.Command
    commandId?: string
    traceId?: string
  }

  export interface ControlResult {
    status: number
    payload: Record<string, unknown>
    tabId: string | null
  }

  interface PendingViewportCommand {
    owner: BrowserOwner.Info
    command: Extract<BrowserControl.Command, { type: "setViewport" }>
    commandId?: string
    traceId?: string
    updatedAt: number
  }

  const pendingViewportCommands = new Map<string, PendingViewportCommand>()

  BrowserHostControl.addGlobalObserver((owner, event) => {
    if (event.type !== "browser.host.status") return
    if (event.status !== "ready" || typeof event.tabId !== "string") return
    flushPendingViewport(owner, event.tabId)
  })

  export function tabPayload(tab: import("./tab.js").BrowserTab) {
    return BrowserControl.tabState(tab)
  }

  export function sessionStatePayload(
    session: BrowserControl.SessionState,
    presentation: BrowserPresentationSelection,
    runtimeHealth?: Awaited<ReturnType<typeof BrowserHost.health>>,
  ) {
    return {
      type: "session.state",
      tabs: session.tabs,
      activeTabId: session.activeTabId,
      connection: { status: "connected" },
      presentation,
      runtimeHealth,
    }
  }

  export async function ensureSession(owner: BrowserOwner.Info): Promise<BrowserSession> {
    return BrowserHost.ensureSession(owner)
  }

  export function mergeCanonicalHostSession(
    canonical: BrowserControl.SessionState,
    hostSession: BrowserControl.SessionState,
  ): BrowserControl.SessionState {
    const hostTabs = new Map(hostSession.tabs.map((tab) => [tab.id, tab]))
    return {
      tabs: canonical.tabs.map((tab) => hostTabs.get(tab.id) ?? tab),
      activeTabId: canonical.activeTabId,
    }
  }

  export async function sessionState(
    state: Pick<State, "owner" | "presentation">,
  ): Promise<BrowserControl.SessionState> {
    const session = await ensureSession(state.owner)
    const canonical = BrowserControl.sessionState(session)
    const hostSession = BrowserHostControl.sessionState(state.owner)
    if (!hostSession) return canonical
    if (state.presentation.kind === "webrtc") return mergeCanonicalHostSession(canonical, hostSession)
    return hostSession
  }

  export function commandTabId(owner: BrowserOwner.Info, command: BrowserControl.Command): string | null {
    if ("tabId" in command && typeof command.tabId === "string" && command.tabId) return command.tabId
    return BrowserHostControl.sessionState(owner)?.activeTabId ?? null
  }

  export function hostReadyTimeoutMs(): number {
    const configured = Number(process.env.SYNERGY_BROWSER_HOST_READY_TIMEOUT_MS)
    return Number.isFinite(configured) && configured >= 0 ? configured : 5_000
  }

  export async function executeControl(
    state: State,
    request: ControlRequest,
    serverUrl: string,
  ): Promise<ControlResult> {
    const { owner, presentation } = state
    const command = BrowserControl.normalizeCommand(request.command)
    const tabId = commandTabId(owner, command)

    if (presentation.kind === "webrtc" && command.type === "createTab") {
      const result = await executeWebRTCCreateTab(state, command, request, serverUrl)
      return {
        status: 202,
        payload: { type: "control.result", result },
        tabId: result.type === "tab" ? result.tab.id : tabId,
      }
    }

    if (presentation.kind === "webrtc" && (command.type === "switchTab" || command.type === "closeTab")) {
      const result = await executeWebRTCTabCommand(owner, command)
      return { status: 200, payload: { type: "control.result", result }, tabId }
    }

    if (
      presentation.kind === "webrtc" &&
      command.type === "setViewport" &&
      tabId &&
      !BrowserHostControl.isReady(owner, tabId)
    ) {
      deferViewport(owner, command, request)
      return {
        status: 202,
        payload: { type: "control.result", result: { type: "void" }, deferred: true, hostStatus: "pending" },
        tabId,
      }
    }

    if (
      presentation.kind === "webrtc" &&
      commandNeedsReadyHost(command) &&
      tabId &&
      !BrowserHostControl.isReady(owner, tabId)
    ) {
      BrowserHostControl.markStatus(owner, tabId, "pending", {
        traceId: request.traceId,
        reason: "control_received_before_host_ready",
      })
      log.info("browser.route.control.deferred", {
        ownerKey: BrowserOwner.key(owner),
        tabId,
        commandId: request.commandId,
        commandType: command.type,
        traceId: request.traceId,
        reason: "host_pending",
      })
      return {
        status: 409,
        payload: hostPendingPayload({ command, commandId: request.commandId, traceId: request.traceId, tabId }),
        tabId,
      }
    }

    const result = await BrowserHost.executeAttached(owner, command, {
      commandId: request.commandId,
      traceId: request.traceId,
    })
    return { status: 200, payload: { type: "control.result", result }, tabId }
  }

  export function hostPendingPayload(input: {
    command: BrowserControl.Command
    commandId?: string
    traceId?: string
    tabId?: string | null
  }) {
    return {
      type: "error",
      code: "browser_host_pending",
      message: "Browser Host is still preparing.",
      retryable: true,
      traceId: input.traceId,
      tabId: input.tabId ?? null,
      commandId: input.commandId,
      commandType: input.command.type,
    }
  }

  function pendingViewportKey(owner: BrowserOwner.Info, tabId: string): string {
    return `${BrowserOwner.key(owner)}:tab:${tabId}:viewport`
  }

  function deferViewport(
    owner: BrowserOwner.Info,
    command: Extract<BrowserControl.Command, { type: "setViewport" }>,
    request: { commandId?: string; traceId?: string },
  ) {
    const tabId = commandTabId(owner, command)
    if (!tabId) return false
    pendingViewportCommands.set(pendingViewportKey(owner, tabId), {
      owner,
      command: { ...command, tabId },
      commandId: request.commandId,
      traceId: request.traceId,
      updatedAt: Date.now(),
    })
    BrowserHostControl.markStatus(owner, tabId, "pending", {
      traceId: request.traceId,
      reason: "viewport_deferred_until_host_ready",
    })
    log.info("browser.route.control.deferred", {
      ownerKey: BrowserOwner.key(owner),
      tabId,
      commandId: request.commandId,
      commandType: command.type,
      traceId: request.traceId,
      reason: "host_pending",
    })
    return true
  }

  function flushPendingViewport(owner: BrowserOwner.Info, tabId: string): void {
    const key = pendingViewportKey(owner, tabId)
    const pending = pendingViewportCommands.get(key)
    if (!pending || !BrowserHostControl.isReady(owner, tabId)) return
    pendingViewportCommands.delete(key)
    void BrowserHostControl.execute(pending.owner, pending.command, {
      commandId: pending.commandId,
      traceId: pending.traceId,
    }).catch((error) => {
      log.warn("browser.route.control.failed", {
        ownerKey: BrowserOwner.key(owner),
        tabId,
        commandId: pending.commandId,
        commandType: pending.command.type,
        traceId: pending.traceId,
        error: error instanceof Error ? error.message : String(error),
        deferredAgeMs: Date.now() - pending.updatedAt,
      })
    })
  }

  function commandNeedsReadyHost(command: BrowserControl.Command): boolean {
    return command.type !== "createTab" && command.type !== "setViewport" && command.type !== "closeTab"
  }

  async function executeWebRTCCreateTab(
    state: State,
    command: Extract<BrowserControl.Command, { type: "createTab" }>,
    request: { commandId?: string; traceId?: string },
    serverUrl: string,
  ) {
    const session = await ensureSession(state.owner)
    const result = await BrowserControl.execute(session, command)
    if (result.type !== "tab") return result

    BrowserHostControl.markStatus(state.owner, result.tab.id, "pending", {
      traceId: request.traceId,
      reason: "tab_created",
    })
    const ensure = BrowserElectronHostProcess.ensure({
      owner: state.owner,
      tabId: result.tab.id,
      serverUrl,
      routeDirectory: state.directory,
      url: result.tab.url,
      traceId: request.traceId,
    })
    log.info("browser.route.control.deferred", {
      ownerKey: BrowserOwner.key(state.owner),
      tabId: result.tab.id,
      commandId: request.commandId,
      commandType: command.type,
      traceId: request.traceId,
      hostProcessKey: ensure.key,
      hostStatus: BrowserHostControl.status(state.owner, result.tab.id),
    })
    return {
      ...result,
      hostStatus: BrowserHostControl.status(state.owner, result.tab.id),
    }
  }

  async function executeWebRTCTabCommand(
    owner: BrowserOwner.Info,
    command: Extract<BrowserControl.Command, { type: "switchTab" | "closeTab" }>,
  ) {
    const session = await ensureSession(owner)
    const result = await BrowserControl.execute(session, command)
    if (command.type === "closeTab") BrowserElectronHostProcess.stop(owner, command.tabId)
    return result
  }
}
