import { generateUUID } from "@ericsanchezok/synergy-util/uuid"

type Anchor = { rootID: string; assistantID: string }
type Result = { proposalID: string; candidate: string | null; stamp: Anchor }
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
      failed(reason: "unavailable" | "abstained"): void
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
      if ((state.binding ?? state.identity) !== this.#binding || !state.eligible || !state.automatic)
        this.#pending = undefined
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
    this.#consumed.add(key)
    if (!state.automatic || !state.eligible) return
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
        const latest = this.adapter.read()
        if (
          this.#disposed ||
          controller.signal.aborted ||
          this.#controller !== controller ||
          latest.identity !== state.identity ||
          !latest.eligible ||
          !latest.ready ||
          result.stamp.rootID !== latest.anchor?.rootID ||
          result.stamp.assistantID !== latest.anchor.assistantID
        )
          return
        if (result.candidate) this.adapter.apply(result)
        else if (manual) this.adapter.failed("abstained")
      })
      .catch(() => {
        if (manual && !controller.signal.aborted) this.adapter.failed("unavailable")
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
