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
    pageId: string | null
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
    if (event.status !== "ready" || typeof event.pageId !== "string") return
    flushPendingViewport(owner, event.pageId)
  })

  export function pagePayload(page: import("./tab.js").BrowserTab) {
    return BrowserControl.pageState(page)
  }

  export function sessionStatePayload(
    session: BrowserControl.SessionState,
    presentation: BrowserPresentationSelection,
    runtimeHealth?: Awaited<ReturnType<typeof BrowserHost.health>>,
  ) {
    return {
      type: "session.state",
      page: session.page,
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
    hostSession: BrowserControl.SessionState | null,
  ): BrowserControl.SessionState {
    if (!hostSession?.page || hostSession.page.id !== canonical.page?.id) return canonical
    return { page: hostSession.page }
  }

  export async function sessionState(
    state: Pick<State, "owner" | "presentation">,
  ): Promise<BrowserControl.SessionState> {
    const session = await ensureSession(state.owner)
    const canonical = BrowserControl.sessionState(session)
    const hostSession = BrowserHostControl.sessionState(state.owner)
    if (state.presentation.kind === "webrtc") return mergeCanonicalHostSession(canonical, hostSession)
    return hostSession ?? canonical
  }

  export function commandPageId(owner: BrowserOwner.Info, command: BrowserControl.Command): string | null {
    if ("pageId" in command && typeof command.pageId === "string" && command.pageId) return command.pageId
    return BrowserHostControl.sessionState(owner)?.page?.id ?? null
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
    let pageId = commandPageId(owner, command)

    if (presentation.kind === "webrtc" && command.type === "navigate") {
      if (pageId && BrowserHostControl.isReady(owner, pageId)) {
        const result = await BrowserHost.executeAttached(
          owner,
          { ...command, pageId },
          {
            commandId: request.commandId,
            traceId: request.traceId,
          },
        )
        await syncCanonicalPageFromHostResult(owner, result)
        return {
          status: 200,
          payload: { type: "control.result", result },
          pageId: resultPageId(result) ?? pageId,
        }
      }
      const result = await executeWebRTCNavigate(state, command, request, serverUrl)
      return {
        status: 202,
        payload: { type: "control.result", result },
        pageId: result.type === "navigation" ? result.page.id : pageId,
      }
    }
    if (
      presentation.kind !== "webrtc" &&
      command.type === "navigate" &&
      (!pageId || !BrowserHostControl.isReady(owner, pageId))
    ) {
      const result = await BrowserHost.executeRuntime(owner, command)
      return {
        status: 200,
        payload: { type: "control.result", result },
        pageId: resultPageId(result) ?? pageId,
      }
    }

    if (
      presentation.kind === "webrtc" &&
      command.type === "setViewport" &&
      pageId &&
      !BrowserHostControl.isReady(owner, pageId)
    ) {
      deferViewport(owner, command, request)
      return {
        status: 202,
        payload: { type: "control.result", result: { type: "void" }, deferred: true, hostStatus: "pending" },
        pageId,
      }
    }

    if (
      presentation.kind === "webrtc" &&
      commandNeedsReadyHost(command) &&
      pageId &&
      !BrowserHostControl.isReady(owner, pageId)
    ) {
      BrowserHostControl.markStatus(owner, pageId, "pending", {
        traceId: request.traceId,
        reason: "control_received_before_host_ready",
      })
      log.info("browser.route.control.deferred", {
        ownerKey: BrowserOwner.key(owner),
        pageId,
        commandId: request.commandId,
        commandType: command.type,
        traceId: request.traceId,
        reason: "host_pending",
      })
      return {
        status: 409,
        payload: hostPendingPayload({ command, commandId: request.commandId, traceId: request.traceId, pageId }),
        pageId,
      }
    }

    const result = await BrowserHost.executeAttached(owner, command, {
      commandId: request.commandId,
      traceId: request.traceId,
    })
    await syncCanonicalPageFromHostResult(owner, result)
    return { status: 200, payload: { type: "control.result", result }, pageId: resultPageId(result) ?? pageId }
  }

  export function hostPendingPayload(input: {
    command: BrowserControl.Command
    commandId?: string
    traceId?: string
    pageId?: string | null
  }) {
    return {
      type: "error",
      code: "browser_host_pending",
      message: "Browser Host is still preparing.",
      retryable: true,
      traceId: input.traceId,
      pageId: input.pageId ?? null,
      commandId: input.commandId,
      commandType: input.command.type,
    }
  }

  export function pageMissingPayload(input: {
    command: BrowserControl.Command
    commandId?: string
    traceId?: string
    pageId?: string | null
  }) {
    return {
      type: "error",
      code: "browser_page_missing",
      message: "No browser page is open.",
      retryable: false,
      traceId: input.traceId,
      pageId: input.pageId ?? null,
      commandId: input.commandId,
      commandType: input.command.type,
    }
  }

  function pendingViewportKey(owner: BrowserOwner.Info, pageId: string): string {
    return `${BrowserOwner.key(owner)}:page:${pageId}:viewport`
  }

  function deferViewport(
    owner: BrowserOwner.Info,
    command: Extract<BrowserControl.Command, { type: "setViewport" }>,
    request: { commandId?: string; traceId?: string },
  ) {
    const pageId = commandPageId(owner, command)
    if (!pageId) return false
    pendingViewportCommands.set(pendingViewportKey(owner, pageId), {
      owner,
      command: { ...command, pageId },
      commandId: request.commandId,
      traceId: request.traceId,
      updatedAt: Date.now(),
    })
    BrowserHostControl.markStatus(owner, pageId, "pending", {
      traceId: request.traceId,
      reason: "viewport_deferred_until_host_ready",
    })
    log.info("browser.route.control.deferred", {
      ownerKey: BrowserOwner.key(owner),
      pageId,
      commandId: request.commandId,
      commandType: command.type,
      traceId: request.traceId,
      reason: "host_pending",
    })
    return true
  }

  function flushPendingViewport(owner: BrowserOwner.Info, pageId: string): void {
    const key = pendingViewportKey(owner, pageId)
    const pending = pendingViewportCommands.get(key)
    if (!pending || !BrowserHostControl.isReady(owner, pageId)) return
    pendingViewportCommands.delete(key)
    void BrowserHostControl.execute(pending.owner, pending.command, {
      commandId: pending.commandId,
      traceId: pending.traceId,
    }).catch((error) => {
      log.warn("browser.route.control.failed", {
        ownerKey: BrowserOwner.key(owner),
        pageId,
        commandId: pending.commandId,
        commandType: pending.command.type,
        traceId: pending.traceId,
        error: error instanceof Error ? error.message : String(error),
        deferredAgeMs: Date.now() - pending.updatedAt,
      })
    })
  }

  function commandNeedsReadyHost(command: BrowserControl.Command): boolean {
    return command.type !== "setViewport"
  }

  function resultPageId(result: BrowserControl.Result): string | null {
    if (result.type === "page" || result.type === "navigation") return result.page.id
    if ("pageId" in result && typeof result.pageId === "string") return result.pageId
    return null
  }

  async function syncCanonicalPageFromHostResult(
    owner: BrowserOwner.Info,
    result: BrowserControl.Result,
  ): Promise<void> {
    if (result.type !== "page" && result.type !== "navigation") return
    const session = await ensureSession(owner)
    const page = session.getPage(result.page.id)
    if (!page) return
    page.url = result.page.url
    page.title = result.page.title
    page.loading = result.page.isLoading
    page.lastActiveAt = result.page.lastActiveAt
    await session.save()
    if (result.type === "navigation") await session.notifyPageNavigated(page)
  }

  async function executeWebRTCNavigate(
    state: State,
    command: Extract<BrowserControl.Command, { type: "navigate" }>,
    request: { commandId?: string; traceId?: string },
    serverUrl: string,
  ) {
    const session = await ensureSession(state.owner)
    const result = await BrowserControl.execute(session, command)
    if (result.type !== "navigation") return result

    BrowserHostControl.markStatus(state.owner, result.page.id, "pending", {
      traceId: request.traceId,
      reason: "page_navigated",
    })
    const ensure = BrowserElectronHostProcess.ensure({
      owner: state.owner,
      pageId: result.page.id,
      serverUrl,
      routeDirectory: state.directory,
      url: result.page.url,
      traceId: request.traceId,
    })
    log.info("browser.route.control.deferred", {
      ownerKey: BrowserOwner.key(state.owner),
      pageId: result.page.id,
      commandId: request.commandId,
      commandType: command.type,
      traceId: request.traceId,
      hostProcessKey: ensure.key,
      hostStatus: BrowserHostControl.status(state.owner, result.page.id),
    })
    return {
      ...result,
      hostStatus: BrowserHostControl.status(state.owner, result.page.id),
    }
  }
}
