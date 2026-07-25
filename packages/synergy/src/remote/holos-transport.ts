import { SynergyLinkBridge, SynergyLinkEnvelope } from "@ericsanchezok/synergy-link-protocol"
import { Envelope } from "@/holos/envelope"
import { HolosRuntime } from "@/holos/runtime"
import type { HolosProvider } from "@/holos/runtime"
import type { SynergyLinkRequest } from "./client"

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

  constructor(private readonly provider: Pick<HolosProvider, "send">) {
    this.#unsubscribe = HolosRuntime.registerAppEventHandler((input) => this.#handleEvent(input))
  }

  async request(targetAgentID: string | undefined, input: SynergyLinkRequest): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(input.requestID)
        reject(new Error(`Timed out waiting for Synergy Link response ${input.requestID}.`))
      }, 30_000)
      timer.unref?.()

      if (!targetAgentID) {
        clearTimeout(timer)
        this.#pending.delete(input.requestID)
        reject(new Error(`Synergy Link request ${input.requestID} is missing a target agent.`))
        return
      }
      this.#pending.set(input.requestID, { resolve, reject, timer, targetAgentID })

      this.provider
        .send(targetAgentID, SynergyLinkBridge.REQUEST_EVENT, input)
        .then((result) => {
          if (!result.sent) {
            clearTimeout(timer)
            this.#pending.delete(input.requestID)
            reject(new Error(`Synergy Link request ${input.requestID} was not delivered.`))
          }
        })
        .catch((error) => {
          clearTimeout(timer)
          this.#pending.delete(input.requestID)
          reject(error instanceof Error ? error : new Error(String(error)))
        })
    })
  }

  dispose() {
    this.#unsubscribe()
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error("Holos Synergy Link transport disposed."))
    }
    this.#pending.clear()
  }

  async #handleEvent(input: { event: string; payload: unknown; caller: Envelope.Caller }): Promise<boolean> {
    if (input.event !== SynergyLinkBridge.RESPONSE_EVENT) return false
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
