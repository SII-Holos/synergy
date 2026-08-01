import {
  BROWSER_HOST_WAIT_TIMEOUT_MS,
  BROWSER_PROTOCOL_VERSION,
  BrowserProtocolError,
  type BrowserPresentationSelection,
  type BrowserSessionState,
} from "@ericsanchezok/synergy-browser"
import { BrowserBroker } from "./broker.js"
import { BrowserCommandService } from "./command-service.js"
import { BrowserControl } from "./control.js"
import { BrowserHostBrokerProcess } from "./host-broker-process.js"
import { BrowserOwner } from "./owner.js"
import { BrowserEvent } from "./event.js"
import { BrowserWebRTCSignaling } from "./webrtc-signaling.js"
import type { BrowserSession } from "./types.js"

export namespace BrowserWorkspace {
  export interface State {
    directory: string
    owner: BrowserOwner.Info
    presentation: BrowserPresentationSelection
    requestedPresentation: "auto" | "native" | "webrtc"
    nativePresentation: boolean
  }

  export interface ControlRequest {
    command: BrowserControl.Command
    commandId: string
    traceId?: string
  }

  export interface ControlResult {
    status: number
    payload: Record<string, unknown>
    pageId: string | null
  }

  export async function ensureSession(owner: BrowserOwner.Info): Promise<BrowserSession> {
    return BrowserCommandService.session(owner)
  }

  export async function sessionState(state: Pick<State, "owner">): Promise<BrowserControl.SessionState> {
    return BrowserControl.sessionState(await ensureSession(state.owner))
  }

  export function sessionStatePayload(
    owner: BrowserOwner.Info,
    session: BrowserControl.SessionState,
    presentation: BrowserPresentationSelection,
  ): BrowserSessionState {
    const watermark = BrowserEvent.watermark(owner)
    return {
      type: "session.state",
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      ownerKey: BrowserOwner.key(owner),
      status: session.status,
      page: session.page,
      presentation,
      hostStatus: pageHostStatus(owner, session, presentation),
      seq: watermark.seq,
      epoch: watermark.epoch,
      ...(session.error ? { error: session.error } : {}),
    }
  }

  function pageHostStatus(
    owner: BrowserOwner.Info,
    session: BrowserControl.SessionState,
    presentation: BrowserPresentationSelection,
  ) {
    if (!session.page) return "detached" as const
    if (BrowserBroker.hasPage(owner, session.page.id)) {
      if (presentation?.kind === "webrtc" && !BrowserWebRTCSignaling.hasHost(owner, session.page.id)) {
        return "detached" as const
      }
      return "ready" as const
    }
    const status = BrowserHostBrokerProcess.status()
    return status === "installing" || status === "starting" || status === "restarting" || status === "failed"
      ? status
      : ("detached" as const)
  }

  export async function executeControl(
    state: State,
    request: ControlRequest,
    serverUrl: string,
  ): Promise<ControlResult> {
    if (!request.commandId.trim()) {
      throw new BrowserProtocolError({
        code: "browser_command_id_required",
        message: "Browser control requests require commandId.",
        retryable: false,
      })
    }
    const command = BrowserControl.normalizeCommand(request.command)
    const needsInteractivePage = command.type === "navigate" || command.type === "resume"
    if (needsInteractivePage && (state.presentation?.kind === "native" || state.nativePresentation)) {
      BrowserBroker.prepare(state.owner, state.directory, "native")
      await waitForBroker("native", 10_000)
    } else if (
      needsInteractivePage &&
      (state.presentation?.kind === "webrtc" || (!state.presentation && state.requestedPresentation !== "native"))
    ) {
      BrowserBroker.prepare(state.owner, state.directory, "webrtc")
      await BrowserHostBrokerProcess.ensure({
        owner: state.owner,
        serverUrl,
        routeDirectory: state.directory,
      })
      await waitForBroker("webrtc", BROWSER_HOST_WAIT_TIMEOUT_MS)
    }

    const result = await BrowserCommandService.execute(state.owner, {
      command,
      commandId: request.commandId,
    })
    const session = await ensureSession(state.owner)
    return {
      status: 200,
      payload: { type: "control.result", protocolVersion: BROWSER_PROTOCOL_VERSION, result },
      pageId: session.page?.id ?? session.descriptor?.id ?? null,
    }
  }

  async function waitForBroker(kind: "native" | "webrtc", timeoutMs: number): Promise<void> {
    const startedAt = Date.now()
    while (true) {
      if (BrowserBroker.ready(kind)) return
      if (kind === "webrtc") {
        const status = BrowserHostBrokerProcess.status()
        if (status === "failed" || status === "unavailable") {
          throw new BrowserProtocolError({
            code: "browser_host_unavailable",
            message: `Browser Host did not register ${kind} capability (host status: ${status}).`,
            retryable: true,
          })
        }
      }
      if (Date.now() - startedAt >= timeoutMs) {
        // The Host may still be installing or starting. Return a retryable
        // pending error so the client can retry in the background instead of
        // holding a synchronous HTTP request open for minutes.
        const detail = kind === "webrtc" ? ` (host status: ${BrowserHostBrokerProcess.status()})` : ""
        throw new BrowserProtocolError({
          code: "browser_host_pending",
          message: `Browser Host is still registering ${kind} capability after ${timeoutMs}ms${detail}.`,
          retryable: true,
        })
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}
