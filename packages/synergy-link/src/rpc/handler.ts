import { SynergyLinkEnvelope, SynergyLinkError } from "@ericsanchezok/synergy-link-protocol"
import { ProcessRegistry } from "../exec/process-registry"
import { SynergyLinkHost, type SynergyLinkHostOptions } from "../host"
import { BashRunner } from "../exec/bash-runner"
import { RPCRequestSchema, type RPCResult } from "./schema"
import { SynergyLinkLog } from "../log"
import type { ExecutionLease } from "../types"

const REQUEST_CACHE_TTL_MS = 10 * 60_000
const MAX_REQUEST_CACHE_ENTRIES = 512

interface CachedRequest {
  createdAt: number
  fingerprint: string
  result: Promise<RPCResult>
  isSettled: () => boolean
}

export class RPCHandler {
  readonly host: SynergyLinkHost
  readonly processRegistry: ProcessRegistry
  readonly bashRunner: BashRunner
  readonly #requests = new Map<string, CachedRequest>()

  constructor(options: SynergyLinkHostOptions = {}) {
    this.host = new SynergyLinkHost(options)
    this.processRegistry = new ProcessRegistry(this.host)
    this.bashRunner = new BashRunner(this.processRegistry)
  }

  async handle(input: unknown, lease: ExecutionLease): Promise<RPCResult> {
    let request: ReturnType<typeof RPCRequestSchema.parse> | undefined
    try {
      request = RPCRequestSchema.parse(input)
      this.host.assertLink(request.linkID)
      if (request.tool === "session" || request.sessionID !== lease.sessionID) {
        throw {
          code: "session_caller_mismatch" as const,
          message: "The validated execution lease does not match this request session.",
        }
      }

      const key = requestCacheKey(lease, request.requestID)
      const fingerprint = requestFingerprint(request)
      const cached = this.#requests.get(key)
      if (cached) {
        if (cached.fingerprint !== fingerprint) {
          return errorResult(
            { requestID: request.requestID, tool: request.tool, action: request.action },
            "invalid_request",
            "requestID was already used for a different Synergy Link request in this session.",
          )
        }
        SynergyLinkLog.info("rpc.request.deduplicated", {
          requestID: request.requestID,
          tool: request.tool,
          action: request.action,
          sessionID: lease.sessionID,
          callerAgentID: lease.callerAgentID,
        })
        return await cached.result
      }
      this.#pruneRequestCache()
      if (this.#requests.size >= MAX_REQUEST_CACHE_ENTRIES) {
        SynergyLinkLog.warn("rpc.request.rejected.capacity", {
          requestID: request.requestID,
          tool: request.tool,
          action: request.action,
          sessionID: lease.sessionID,
          callerAgentID: lease.callerAgentID,
        })
        return errorResult(
          { requestID: request.requestID, tool: request.tool, action: request.action },
          "execution_failed",
          "The Synergy Link host has too many in-flight requests. Retry this request after capacity becomes available.",
          { reason: "request_capacity_exhausted", retryable: true },
        )
      }

      let settled = false
      const result = this.#execute(request as Exclude<typeof request, { tool: "session" }>, lease)
      result.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        },
      )
      this.#requests.set(key, { createdAt: Date.now(), fingerprint, result, isSettled: () => settled })
      return await result
    } catch (error) {
      return this.#errorResult(error, request)
    }
  }

  clearSessionRequests(sessionID: string) {
    for (const key of this.#requests.keys()) {
      if (key.startsWith(`${sessionID}\u0000`)) this.#requests.delete(key)
    }
  }

  async #execute(
    request: Exclude<ReturnType<typeof RPCRequestSchema.parse>, { tool: "session" }>,
    lease: ExecutionLease,
  ): Promise<RPCResult> {
    SynergyLinkLog.info("rpc.request.received", {
      requestID: request.requestID,
      tool: request.tool,
      action: request.action,
      linkID: request.linkID,
      sessionID: request.sessionID,
      payload: request.payload,
    })

    if (request.tool === "bash") {
      const result = await this.bashRunner.run(request.payload, request.linkID, lease)
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

    const result = await this.processRegistry.execute(request.payload, request.linkID, lease)
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

  #errorResult(error: unknown, request?: ReturnType<typeof RPCRequestSchema.parse>): RPCResult {
    if (isEnvelopeError(error)) {
      SynergyLinkLog.warn("rpc.request.failed.envelope", {
        code: error.code,
        message: error.message,
        details: error.details,
      })
      return errorResult(
        {
          requestID: error.requestID ?? request?.requestID,
          tool: error.tool ?? request?.tool,
          action: error.action ?? request?.action,
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
      "The Synergy Link host encountered an internal error.",
    )
  }

  #pruneRequestCache(now = Date.now()) {
    for (const [key, entry] of this.#requests) {
      if (entry.isSettled() && now - entry.createdAt > REQUEST_CACHE_TTL_MS) this.#requests.delete(key)
    }
    if (this.#requests.size < MAX_REQUEST_CACHE_ENTRIES) return
    for (const [key, entry] of this.#requests) {
      if (this.#requests.size < MAX_REQUEST_CACHE_ENTRIES) break
      if (entry.isSettled()) this.#requests.delete(key)
    }
  }
}

function requestCacheKey(lease: ExecutionLease, requestID: string) {
  return `${lease.sessionID}\u0000${lease.callerAgentID}\u0000${lease.callerOwnerUserID}\u0000${requestID}`
}

function requestFingerprint(request: ReturnType<typeof RPCRequestSchema.parse>) {
  return JSON.stringify(request)
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
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    SynergyLinkError.Code.safeParse(error.code).success &&
    "message" in error &&
    typeof error.message === "string"
  )
}
