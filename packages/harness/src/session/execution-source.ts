import { RuntimeContext } from "../lifecycle/context"

export namespace SessionExecutionSource {
  export interface Input {
    sessionID: string
    scopeID: string
    parentSessionID?: string
    signal?: AbortSignal
  }
  export interface Source {
    authorize(input: Readonly<Input>): Promise<void>
  }
  export class DeniedError extends Error {
    constructor(cause: unknown) {
      super("The host did not authorize Session execution", { cause })
      this.name = "SessionExecutionDeniedError"
    }
  }
  const state = RuntimeContext.state(() => ({ source: undefined as Source | undefined }))

  export function register(source: Source) {
    RuntimeContext.assertCompositionOpen("Session execution source")
    if (state().source) throw new Error("Session execution source is already registered")
    state().source = source
  }

  export function configured() {
    return state().source !== undefined
  }

  export async function authorize(input: Input) {
    input.signal?.throwIfAborted()
    try {
      await state().source?.authorize(Object.freeze({ ...input }))
    } catch (error) {
      input.signal?.throwIfAborted()
      throw new DeniedError(error)
    }
    input.signal?.throwIfAborted()
  }
}
