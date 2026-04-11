import { MetaProtocolBridge, MetaProtocolEnvelope } from "@ericsanchezok/meta-protocol"
import { Envelope } from "@/holos/envelope"
import { HolosProvider, HolosRuntime } from "@/holos/runtime"
import type { RemoteExecutionRequest } from "./client"

export class HolosRemoteExecutionTransport {
  readonly #pending = new Map<
    string,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  readonly #unsubscribe: () => void

  constructor(private readonly provider: HolosProvider) {
    this.#unsubscribe = HolosRuntime.registerAppEventHandler((input) => this.#handleEvent(input))
  }

  async request(input: RemoteExecutionRequest): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(input.requestID)
        reject(new Error(`Timed out waiting for remote response ${input.requestID}.`))
      }, 30_000)
      timer.unref?.()

      this.#pending.set(input.requestID, { resolve, reject, timer })

      if (!input.targetAgentID) {
        clearTimeout(timer)
        this.#pending.delete(input.requestID)
        reject(new Error(`Remote request ${input.requestID} is missing targetAgentID.`))
        return
      }

      this.provider
        .send(input.targetAgentID, MetaProtocolBridge.RequestEvent, input)
        .then((result) => {
          if (result.queued) {
            clearTimeout(timer)
            this.#pending.delete(input.requestID)
            reject(new Error(`Remote request ${input.requestID} was queued instead of delivered.`))
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
      pending.reject(new Error("Holos remote transport disposed."))
    }
    this.#pending.clear()
  }

  async #handleEvent(input: { event: string; payload: unknown; caller: Envelope.Caller }): Promise<boolean> {
    if (input.event !== MetaProtocolBridge.ResponseEvent) return false
    const parsed = MetaProtocolEnvelope.ResultBase.safeParse(input.payload)
    if (!parsed.success) return false
    const pending = this.#pending.get(parsed.data.requestID)
    if (!pending) return false
    clearTimeout(pending.timer)
    this.#pending.delete(parsed.data.requestID)
    pending.resolve(input.payload)
    return true
  }
}
