import { SynergyLinkEnvelope, SynergyLinkError } from "@ericsanchezok/synergy-link-protocol"
import { ProcessRegistry } from "../exec/process-registry"
import { SynergyLinkHost, type SynergyLinkHostOptions } from "../host"
import { BashRunner } from "../exec/bash-runner"
import { RPCRequestSchema } from "./schema"
import { SynergyLinkLog } from "../log"

export class RPCHandler {
  readonly host: SynergyLinkHost
  readonly processRegistry: ProcessRegistry
  readonly bashRunner: BashRunner

  constructor(options: SynergyLinkHostOptions = {}) {
    this.host = new SynergyLinkHost(options)
    this.processRegistry = new ProcessRegistry(this.host)
    this.bashRunner = new BashRunner(this.processRegistry)
  }

  async handle(input: unknown) {
    let request: ReturnType<typeof RPCRequestSchema.parse> | undefined
    try {
      request = RPCRequestSchema.parse(input)
      this.host.assertLink(request.linkID)
      SynergyLinkLog.info("rpc.request.received", {
        requestID: request.requestID,
        tool: request.tool,
        action: request.action,
        linkID: request.linkID,
        sessionID: "sessionID" in request ? request.sessionID : undefined,
        payload: request.payload,
      })

      if (request.tool === "bash") {
        const result = await this.bashRunner.run(request.payload, request.linkID)
        const response = {
          version: SynergyLinkEnvelope.VERSION,
          requestID: request.requestID,
          ok: true,
          tool: request.tool,
          action: request.action,
          result,
        } as const
        SynergyLinkLog.info("rpc.request.completed", {
          requestID: request.requestID,
          tool: request.tool,
          action: request.action,
          result,
        })
        return response
      }

      if (request.tool === "process") {
        const result = await this.processRegistry.execute(request.payload, request.linkID)
        const response = {
          version: SynergyLinkEnvelope.VERSION,
          requestID: request.requestID,
          ok: true,
          tool: request.tool,
          action: request.action,
          result,
        } as const
        SynergyLinkLog.info("rpc.request.completed", {
          requestID: request.requestID,
          tool: request.tool,
          action: request.action,
          result,
        })
        return response
      }

      return errorResult(
        { requestID: request.requestID, tool: request.tool, action: request.action },
        "unsupported_tool",
        "Unsupported tool",
      )
    } catch (error) {
      if (isEnvelopeError(error)) {
        SynergyLinkLog.warn("rpc.request.failed.envelope", {
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

      SynergyLinkLog.error("rpc.request.failed.unexpected", {
        error: error instanceof Error ? error.message : String(error),
      })
      return errorResult(
        request
          ? {
              requestID: request.requestID,
              tool: request.tool,
              action: request.action,
            }
          : undefined,
        "execution_failed",
        error instanceof Error ? error.message : String(error),
      )
    }
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
    error: {
      code,
      message,
      details,
    },
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
