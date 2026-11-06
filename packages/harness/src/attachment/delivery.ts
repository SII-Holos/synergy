import { RuntimeContext } from "../lifecycle/context"
import RESPONSE from "./guidance.txt"
import EXECUTION from "./execution-guidance.txt"

/** Model instructions for the delivery mechanism selected by the host. */
export namespace AttachmentDelivery {
  export interface Guidance {
    readonly response: string
    readonly execution: string
  }

  const defaults: Guidance = Object.freeze({ response: RESPONSE, execution: EXECUTION })
  const state = RuntimeContext.state(() => ({ guidance: undefined as Guidance | undefined }))

  export function register(guidance: Guidance) {
    RuntimeContext.assertCompositionOpen("attachment delivery guidance")
    if (state().guidance) throw new Error("Attachment delivery guidance is already registered")
    if (!guidance.response.trim() || !guidance.execution.trim())
      throw new Error("Attachment delivery requires response and execution guidance")
    state().guidance = Object.freeze({ response: guidance.response, execution: guidance.execution })
  }

  export function guidance(): Guidance {
    return state().guidance ?? defaults
  }
}
