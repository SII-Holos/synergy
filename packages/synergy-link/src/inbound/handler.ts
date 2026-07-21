import { SynergyLinkEnvelope, SynergyLinkError, SynergyLinkSession } from "@ericsanchezok/synergy-link-protocol"
import { HolosCallerSchema, type HolosCaller } from "../types"
import { RPCHandler } from "../rpc/handler"
import { RPCRequestSchema, type RPCResult } from "../rpc/schema"
import { SessionManager } from "../session/manager"
import { SynergyLinkLog } from "../log"

export type SessionOpenDecision = "approve" | "deny" | "pending"

export class SynergyLinkInboundHandler {
  constructor(
    readonly rpc: RPCHandler,
    readonly sessions: SessionManager,
    readonly decideOpen: (input: { caller: HolosCaller; label?: string }) => Promise<SessionOpenDecision>,
  ) {}

  async handle(input: { caller: HolosCaller | unknown; body: unknown }): Promise<RPCResult> {
    try {
      const caller = HolosCallerSchema.parse(input.caller)
      const request = RPCRequestSchema.parse(input.body)
      SynergyLinkLog.info("inbound.request.accepted", {
        callerAgentID: caller.agentID,
        callerOwnerUserID: caller.ownerUserID,
        tool: request.tool,
        action: request.action,
        requestID: request.requestID,
        linkID: request.linkID,
        sessionID: "sessionID" in request ? request.sessionID : undefined,
        payload: request.payload,
      })

      if (request.tool === "session") {
        return this.#handleSession(caller, request)
      }

      this.sessions.validateCaller(caller, request.sessionID)
      const result = await this.rpc.handle(request)
      SynergyLinkLog.info("inbound.request.completed", {
        callerAgentID: caller.agentID,
        tool: request.tool,
        action: request.action,
        requestID: request.requestID,
        result,
      })
      return result
    } catch (error) {
      if (isEnvelopeError(error)) {
        const callerAgentID =
          typeof input.caller === "object" && input.caller !== null && "agentID" in input.caller
            ? String((input.caller as { agentID?: unknown }).agentID ?? "unknown")
            : "unknown"
        SynergyLinkLog.warn("inbound.request.failed.envelope", {
          callerAgentID,

          code: error.code,
          message: error.message,
          details: error.details,
        })
        return errorResult(
          {
            requestID: error.requestID,
            tool: error.tool,
            action: error.action,
          },
          error.code,
          error.message,
          error.details,
        )
      }

      const callerAgentID =
        typeof input.caller === "object" && input.caller !== null && "agentID" in input.caller
          ? String((input.caller as { agentID?: unknown }).agentID ?? "unknown")
          : "unknown"
      SynergyLinkLog.error("inbound.request.failed.unexpected", {
        callerAgentID,

        error: error instanceof Error ? error.message : String(error),
      })
      return errorResult(undefined, "host_internal_error", error instanceof Error ? error.message : String(error))
    }
  }

  async #handleSession(
    caller: HolosCaller,
    request: SynergyLinkSession.ExecuteRequest,
  ): Promise<SynergyLinkSession.ExecuteResult | SynergyLinkEnvelope.ErrorResult> {
    SynergyLinkLog.info("session.request.received", {
      callerAgentID: caller.agentID,
      callerOwnerUserID: caller.ownerUserID,
      action: request.payload.action,
      requestID: request.requestID,
      payload: request.payload,
    })
    this.rpc.host.assertLink(request.linkID)

    if (request.payload.action === "open" && !this.sessions.current()) {
      const decision = await this.decideOpen({
        caller,
        label: request.payload.label,
      })
      if (decision !== "approve") {
        const message =
          decision === "deny"
            ? "Collaboration request denied by host policy."
            : "Collaboration request queued for CLI approval. Retry after approval."
        SynergyLinkLog.warn("session.request.refused.approval", {
          callerAgentID: caller.agentID,
          requestID: request.requestID,
          decision,
        })
        return sessionResult(request, {
          action: "open",
          status: "refused",
          title: decision === "deny" ? "Session denied" : "Session pending approval",
          output: message,
          host: this.rpc.host.hello(),
        })
      }
    }

    let result: SynergyLinkSession.Result
    switch (request.payload.action) {
      case "open":
        result = await this.sessions.open(caller, request.payload.label)
        break
      case "close":
        result = await this.sessions.close(caller, request.payload.sessionID)
        break
      case "heartbeat":
        result = await this.sessions.heartbeat(caller, request.payload.sessionID)
        break
    }
    result = {
      ...result,
      metadata: {
        ...result.metadata,
        host: this.rpc.host.hello(),
      },
    }

    const response = {
      version: SynergyLinkEnvelope.VERSION,
      requestID: request.requestID,
      ok: true,
      tool: request.tool,
      action: request.action,
      result,
    } as const

    SynergyLinkLog.info("session.request.completed", {
      callerAgentID: caller.agentID,
      requestID: request.requestID,
      action: request.payload.action,
      status: result.metadata.status,
      sessionID: result.metadata.sessionID,
      result,
    })

    return response
  }
}

function sessionResult(
  request: SynergyLinkSession.ExecuteRequest,
  input: {
    action: SynergyLinkSession.Action
    status: SynergyLinkSession.Status
    title: string
    output: string
    sessionID?: string
    remoteAgentID?: string
    remoteOwnerUserID?: number
    label?: string
    host?: SynergyLinkSession.ResultMetadata["host"]
  },
): SynergyLinkSession.ExecuteResult {
  return {
    version: SynergyLinkEnvelope.VERSION,
    requestID: request.requestID,
    ok: true,
    tool: request.tool,
    action: request.action,
    result: {
      title: input.title,
      metadata: {
        action: input.action,
        status: input.status,
        sessionID: input.sessionID,
        remoteAgentID: input.remoteAgentID,
        remoteOwnerUserID: input.remoteOwnerUserID,
        label: input.label,
        backend: "remote",
        host: input.host,
      },
      output: input.output,
    },
  }
}

function errorResult(
  request:
    | {
        requestID?: string
        tool?: SynergyLinkEnvelope.Tool
        action?: string
      }
    | undefined,
  code: SynergyLinkError.Code,
  message: string,
  details?: unknown,
): SynergyLinkEnvelope.ErrorResult {
  return {
    version: SynergyLinkEnvelope.VERSION,
    requestID: request?.requestID || crypto.randomUUID(),
    ok: false,
    tool: request?.tool,
    action: request?.action,
    error: { code, message, details },
  }
}

function isEnvelopeError(error: unknown): error is {
  requestID?: string
  tool?: SynergyLinkEnvelope.Tool
  action?: string
  code: SynergyLinkError.Code
  message: string
  details?: unknown
} {
  return typeof error === "object" && error !== null && "code" in error && "message" in error
}
