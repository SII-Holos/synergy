import { SynergyLinkBridge, SynergyLinkEnvelope } from "@ericsanchezok/synergy-link-protocol"
import { SynergyLinkRemoteError } from "@/remote/client"
import type { SynergyLinkRequest, SynergyLinkTransportFailureReason } from "@/remote/client"
import { HolosRuntime } from "@/holos/runtime"
import type { HolosProvider } from "@/holos/runtime"
import { Envelope } from "@/holos/envelope"
export class HolosSynergyLinkTransport {
  readonly #pending = new Map<
    string,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
      targetAgentID: string
    }
  >()
  readonly #unsubscribe: () => void
  readonly #timeoutMs: number
  #disposed = false

  constructor(
    private readonly provider: Pick<HolosProvider, "send"> & object,
    options?: { timeoutMs?: number },
  ) {
    this.#timeoutMs = options?.timeoutMs ?? 30_000
    this.#unsubscribe = HolosRuntime.registerAppEventHandler((input) => this.#handleEvent(input))
  }

  async request(targetAgentID: string | undefined, input: SynergyLinkRequest): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(input.requestID)
        reject(
          new SynergyLinkRemoteError(
            "transport_error",
            `Timed out waiting for Synergy Link response ${input.requestID}. The request was dispatched and its result is unknown.`,
            { reason: "timeout", dispatched: true },
          ),
        )
      }, this.#timeoutMs)
      timer.unref?.()

      if (!targetAgentID) {
        clearTimeout(timer)
        this.#pending.delete(input.requestID)
        reject(
          new SynergyLinkRemoteError(
            "invalid_request",
            `Synergy Link request ${input.requestID} is missing a target agent.`,
            { dispatched: false },
          ),
        )
        return
      }
      this.#pending.set(input.requestID, { resolve, reject, timer, targetAgentID })

      this.provider
        .send(targetAgentID, SynergyLinkBridge.REQUEST_EVENT, input)
        .then((result) => {
          if (!result.sent) {
            clearTimeout(timer)
            this.#pending.delete(input.requestID)
            const reason = result.reason ?? "delivery_failed"
            const resultUnknown = reason === "transport_liveness_lost" || reason === "disconnected"
            const message = resultUnknown
              ? `Synergy Link request ${input.requestID} was dispatched, but the Holos transport ${
                  reason === "transport_liveness_lost" ? "lost liveness" : "disconnected"
                } before a response arrived. Its result is unknown.`
              : `Synergy Link request ${input.requestID} was not delivered: ${describeSendReason(reason)}.`
            reject(
              new SynergyLinkRemoteError(reason === "offline" ? "link_inactive" : "transport_error", message, {
                reason,
                dispatched: resultUnknown,
              }),
            )
          }
        })
        .catch((error) => {
          clearTimeout(timer)
          this.#pending.delete(input.requestID)
          reject(normalizeSendFailure(error, input.requestID))
        })
    })
  }

  dispose(reason: SynergyLinkTransportFailureReason = "disconnected") {
    if (this.#disposed) return
    this.#disposed = true
    this.#unsubscribe()
    for (const [requestID, pending] of this.#pending) {
      clearTimeout(pending.timer)
      const message =
        reason === "transport_liveness_lost"
          ? `Synergy Link request ${requestID} was dispatched, but the Holos transport lost liveness before a response arrived. Its result is unknown.`
          : `Synergy Link request ${requestID} was dispatched, but the Holos transport disconnected before a response arrived. Its result is unknown.`
      pending.reject(new SynergyLinkRemoteError("transport_error", message, { reason, dispatched: true }))
    }
    this.#pending.clear()
  }

  async #handleEvent(input: {
    event: string
    payload: unknown
    caller: Envelope.Caller
    source: object
  }): Promise<boolean> {
    if (input.source !== this.provider || input.event !== SynergyLinkBridge.RESPONSE_EVENT) return false
    const parsed = parseResultCorrelation(input.payload)
    if (!parsed) return false
    const pending = this.#pending.get(parsed.requestID)
    if (!pending || input.caller.agent_id !== pending.targetAgentID) return false
    clearTimeout(pending.timer)
    this.#pending.delete(parsed.requestID)
    pending.resolve(input.payload)
    return true
  }
}

function parseResultCorrelation(input: unknown): SynergyLinkEnvelope.ResultBase | undefined {
  if (!input || typeof input !== "object") return
  const candidate = input as Record<string, unknown>
  const parsed = SynergyLinkEnvelope.ResultBase.safeParse({
    version: candidate.version,
    requestID: candidate.requestID,
    ok: candidate.ok,
  })
  return parsed.success ? parsed.data : undefined
}

function describeSendReason(reason: string): string {
  switch (reason) {
    case "not_connected":
      return "the Synergy Link tunnel is not connected"
    case "offline":
      return "the target agent appears to be offline"
    case "delivery_failed":
      return "the gateway reported a delivery failure"
    default:
      return reason
  }
}

function normalizeSendFailure(error: unknown, requestID: string): SynergyLinkRemoteError {
  if (error instanceof SynergyLinkRemoteError) return error
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    const details = (error as { details?: unknown }).details
    return new SynergyLinkRemoteError(
      (error as { code: SynergyLinkRemoteError["code"] }).code,
      (error as { message: string }).message,
      {
        ...(typeof details === "object" && details !== null ? (details as Record<string, unknown>) : {}),
        dispatched: false,
      },
    )
  }
  return new SynergyLinkRemoteError(
    "transport_error",
    error instanceof Error ? error.message : `Synergy Link request ${requestID} failed to dispatch.`,
    { dispatched: false },
  )
}
