/**
 * S9c source inversion: the L1 session processor classifies rejected
 * interactive questions through this registry instead of importing the
 * question product domain. The L4 product manifest registers the error
 * class; unregistered lookups classify nothing as rejected.
 */
export namespace SessionQuestionErrors {
  type RejectedErrorClass = abstract new () => Error

  let rejectedError: RejectedErrorClass | undefined

  export function registerRejectedError(value: RejectedErrorClass): void {
    rejectedError = value
  }

  export function get(): RejectedErrorClass | undefined {
    return rejectedError
  }

  export function isRejected(error: unknown): boolean {
    return rejectedError !== undefined && error instanceof rejectedError
  }

  export function isRejectedErrorName(name: string | undefined): boolean {
    return name !== undefined && rejectedError !== undefined && name === rejectedError.name
  }
}
