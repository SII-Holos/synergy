import { RuntimeContext } from "../lifecycle/context"
/**
 * S9c source inversion: the L1 session processor classifies rejected
 * interactive questions through this registry instead of importing the
 * question product domain. The L4 product manifest registers the error
 * class; unregistered lookups classify nothing as rejected.
 */
export namespace SessionQuestionErrors {
  type RejectedErrorClass = abstract new () => Error

  const runtimeState = RuntimeContext.state(() => ({
    rejectedError: undefined as RejectedErrorClass | undefined,
  }))

  export function registerRejectedError(value: RejectedErrorClass): void {
    const instanceState = runtimeState()

    instanceState.rejectedError = value
  }

  export function get(): RejectedErrorClass | undefined {
    const instanceState = runtimeState()

    return instanceState.rejectedError
  }

  export function isRejected(error: unknown): boolean {
    const instanceState = runtimeState()

    return instanceState.rejectedError !== undefined && error instanceof instanceState.rejectedError
  }

  export function isRejectedErrorName(name: string | undefined): boolean {
    const instanceState = runtimeState()

    return name !== undefined && instanceState.rejectedError !== undefined && name === instanceState.rejectedError.name
  }
}
