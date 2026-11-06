import { RuntimeContext } from "../lifecycle/context"

export namespace ModelExecution {
  export type Mode = "worker" | "in-process"
  const state = RuntimeContext.state(() => ({ mode: undefined as Mode | undefined }))

  /** Select the production inference isolation before Runtime admission opens. */
  export function register(mode: Mode): void {
    RuntimeContext.assertCompositionOpen("model execution")
    if (state().mode !== undefined) throw new Error("Model execution is already registered")
    state().mode = mode
  }

  export function mode(): Mode {
    return state().mode ?? "worker"
  }
}
