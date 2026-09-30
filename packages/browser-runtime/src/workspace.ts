import {
  BROWSER_PROTOCOL_VERSION,
  BrowserProtocolError,
  type BrowserPresentationSelection,
  type BrowserSessionState,
} from "@ericsanchezok/synergy-browser-core"
import { BrowserBroker } from "./broker.js"
import { BrowserCommandService } from "./command-service.js"
import { BrowserControl } from "./control.js"
import { BrowserOwner } from "./owner.js"
import { BrowserEvent } from "./event.js"
import type { BrowserSession } from "./types.js"

export namespace BrowserWorkspace {
  export interface State {
    directory: string
    owner: BrowserOwner.Info
    presentation: BrowserPresentationSelection
    requestedPresentation: "auto" | "native"
    nativePresentation: boolean
  }
  export interface ControlRequest {
    pageId: string
    command: BrowserControl.Command
    commandId: string
    traceId?: string
  }
  export interface ControlResult {
    status: number
    payload: Record<string, unknown>
    pageId: string
  }
  export function ensureSession(owner: BrowserOwner.Info): Promise<BrowserSession> {
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
    return {
      type: "session.state",
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      ownerKey: BrowserOwner.key(owner),
      status: session.status,
      pages: session.pages,
      presentation,
      hostStatus: BrowserBroker.ready("native") ? "ready" : "detached",
      ...BrowserEvent.watermark(owner),
    }
  }
  export async function executeControl(
    state: State,
    request: ControlRequest,
    _serverUrl: string,
  ): Promise<ControlResult> {
    if (!state.nativePresentation)
      throw new BrowserProtocolError({
        code: "browser_desktop_required",
        message: "Open this task in Desktop to use the built-in browser.",
        retryable: false,
      })
    const result = await BrowserCommandService.execute(state.owner, {
      pageId: request.pageId,
      command: BrowserControl.normalizeCommand(request.command),
      commandId: request.commandId,
    })
    return {
      status: 200,
      payload: { type: "control.result", protocolVersion: BROWSER_PROTOCOL_VERSION, result },
      pageId: request.pageId,
    }
  }
}
