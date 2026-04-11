import { MetaProtocolEnvelope, MetaProtocolError } from "@ericsanchezok/meta-protocol"
import { ProcessRegistry } from "../exec/process-registry"
import { MetaSynergyHost, type MetaSynergyHostOptions } from "../host"
import { BashRunner } from "../exec/bash-runner"
import { RPCRequestSchema } from "./schema"
import { MetaSynergyLog } from "../log"

export class RPCHandler {
  readonly host: MetaSynergyHost
  readonly processRegistry: ProcessRegistry
  readonly bashRunner: BashRunner

  constructor(options: MetaSynergyHostOptions = {}) {
    this.host = new MetaSynergyHost(options)
    this.processRegistry = new ProcessRegistry(this.host)
    this.bashRunner = new BashRunner(this.processRegistry)
  }

  async handle(input: unknown) {
    let request: ReturnType<typeof RPCRequestSchema.parse> | undefined
    try {
      request = RPCRequestSchema.parse(input)
      this.host.assertEnv(request.envID)
      MetaSynergyLog.info("rpc.request.received", {
        requestID: request.requestID,
        tool: request.tool,
        action: request.action,
        envID: request.envID,
        sessionID: "sessionID" in request ? request.sessionID : undefined,
        payload: request.payload,
      })

      if (request.tool === "bash") {
        const result = await this.bashRunner.run(request.payload, request.envID)
        const response = {
          version: 1,
          requestID: request.requestID,
          ok: true,
          tool: request.tool,
          action: request.action,
          result,
        } as const
        MetaSynergyLog.info("rpc.request.completed", {
          requestID: request.requestID,
          tool: request.tool,
          action: request.action,
          result,
        })
        return response
      }

      if (request.tool === "process") {
        const result = await this.processRegistry.execute(request.payload, request.envID)
        const response = {
          version: 1,
          requestID: request.requestID,
          ok: true,
          tool: request.tool,
          action: request.action,
          result,
        } as const
        MetaSynergyLog.info("rpc.request.completed", {
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
        MetaSynergyLog.warn("rpc.request.failed.envelope", {
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

      MetaSynergyLog.error("rpc.request.failed.unexpected", {
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
        "host_internal_error",
        error instanceof Error ? error.message : String(error),
      )
    }
  }
}

function errorResult(
  request:
    | {
        requestID?: string
        tool?: MetaProtocolEnvelope.Tool
        action?: string
      }
    | undefined,
  code: MetaProtocolError.Code,
  message: string,
  details?: unknown,
): MetaProtocolEnvelope.ErrorResult {
  return {
    version: 1,
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
  tool?: MetaProtocolEnvelope.Tool
  action?: string
  code: MetaProtocolError.Code
  message: string
  details?: unknown
} {
  return typeof error === "object" && error !== null && "code" in error && "message" in error
}
