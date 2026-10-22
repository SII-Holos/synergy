import { generateUUID } from "@ericsanchezok/synergy-util/uuid"

type Anchor = { rootID: string; assistantID: string }
type Result = { proposalID: string; candidate: string; stamp: Anchor }
export type PredictionState = {
  identity: string
  binding?: string
  sessionID?: string
  anchor?: Anchor
  eligible: boolean
  ready: boolean
  automatic: boolean
}

export class PredictionRequest {
  #controller?: AbortController
  #identity?: string
  #binding?: string
  #automatic?: boolean
  #eligible?: boolean
  #ready?: boolean
  #pending?: Anchor
  #consumed = new Set<string>()
  #disposed = false
  constructor(
    private readonly adapter: {
      read(): PredictionState
      call(input: { sessionID: string; expected: Anchor; requestID: string }, signal: AbortSignal): Promise<Result>
      apply(result: Result): void
      clearFeedback(): void
      failed(): void
      changed(busy: boolean): void
    },
  ) {}

  update() {
    const state = this.adapter.read()
    if (
      state.identity !== this.#identity ||
      (this.#eligible && !state.eligible) ||
      (this.#ready && !state.ready) ||
      (this.#automatic && !state.automatic)
    ) {
      this.#controller?.abort()
      this.#controller = undefined
      // A pending automatic attempt survives readiness and eligibility churn:
      // both flip while a finished turn settles, and dropping the attempt there
      // meant a completed turn could produce no suggestion at all. Only another
      // conversation or a disabled setting invalidates it.
      if ((state.binding ?? state.identity) !== this.#binding || !state.automatic) this.#pending = undefined
      this.adapter.clearFeedback()
      this.adapter.changed(false)
    }
    this.#identity = state.identity
    this.#binding = state.binding ?? state.identity
    this.#automatic = state.automatic
    this.#eligible = state.eligible
    this.#ready = state.ready
    if (this.#pending && state.ready && state.anchor?.rootID === this.#pending.rootID) {
      const pending = this.#pending
      this.#pending = undefined
      if (state.anchor?.rootID === pending.rootID && state.anchor.assistantID === pending.assistantID) this.#run(false)
    }
  }

  completed(anchor: Anchor) {
    const state = this.adapter.read()
    const key = `${state.sessionID}/${anchor.rootID}/${anchor.assistantID}`
    if (this.#consumed.has(key)) return
    if (this.#consumed.size >= 512) this.#consumed.delete(this.#consumed.values().next().value!)
    this.#consumed.add(key)
    if (!state.automatic) return
    this.update()
    this.#pending = anchor
    this.update()
  }

  manual() {
    this.#run(true)
  }

  #run(manual: boolean) {
    const state = this.adapter.read()
    if (this.#disposed || !state.eligible || !state.ready || !state.anchor || !state.sessionID) return
    this.#controller?.abort()
    const controller = new AbortController()
    this.#controller = controller
    this.adapter.clearFeedback()
    this.adapter.changed(true)
    void this.adapter
      .call({ sessionID: state.sessionID, expected: state.anchor, requestID: generateUUID() }, controller.signal)
      .then((result) => {
        if (this.#disposed || controller.signal.aborted || this.#controller !== controller) return
        const latest = this.adapter.read()
        // Only the finished turn this prediction describes still has to be the
        // current one. Eligibility, readiness and the composer revision are
        // recomputed on every composer revision, so they flip while a request is
        // in flight; requiring them here discarded answers the server had
        // already returned, which is why a click could produce neither a
        // suggestion nor a failure.
        if (result.stamp.rootID !== latest.anchor?.rootID || result.stamp.assistantID !== latest.anchor.assistantID)
          return
        this.adapter.apply(result)
      })
      .catch(() => {
        if (manual && !controller.signal.aborted) this.adapter.failed()
      })
      .finally(() => {
        if (this.#controller === controller) {
          this.#controller = undefined
          this.adapter.changed(false)
        }
      })
  }

  dispose() {
    this.#disposed = true
    this.#controller?.abort()
    this.#pending = undefined
    this.#consumed.clear()
  }
}
