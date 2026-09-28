import { z } from "zod"

export namespace WorkspaceErrors {
  export class ConflictError extends Error {
    override name = "WorkspaceFileWriteConflictError"
    constructor() {
      super("File changed on disk; read it again before writing")
    }
  }
  export class AccessDeniedError extends Error {
    override name = "WorkspaceFileAccessDeniedError"
  }
  export class LimitError extends Error {
    override name = "WorkspaceFileTooLargeError"
  }
  export class PartialError extends Error {
    override name = "WorkspaceFilePartialMutationError"
    constructor(
      message: string,
      readonly completed: string[],
      options?: ErrorOptions,
    ) {
      super(message, options)
    }
  }
  export const Failure = z.object({
    name: z.string().max(256),
    message: z.string().max(8192),
    code: z.string().max(128).optional(),
    completed: z.array(z.string()).optional(),
  })
  export type Failure = z.infer<typeof Failure>

  export function failure(error: unknown): Failure {
    return {
      name: error instanceof Error ? error.name.slice(0, 256) : "Error",
      message: (error instanceof Error ? error.message : String(error)).slice(0, 8192),
      code:
        error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code.slice(0, 128)
          : undefined,
      completed: error instanceof PartialError ? error.completed : undefined,
    }
  }

  export function restore(failure: Failure): Error {
    const error =
      failure.name === "WorkspaceFileWriteConflictError"
        ? new ConflictError()
        : failure.name === "WorkspaceFileAccessDeniedError"
          ? new AccessDeniedError(failure.message)
          : failure.name === "WorkspaceFileTooLargeError"
            ? new LimitError(failure.message)
            : failure.name === "WorkspaceFilePartialMutationError"
              ? new PartialError(failure.message, failure.completed ?? [])
              : Object.assign(new Error(failure.message), { name: failure.name })
    if (failure.code) Object.assign(error, { code: failure.code })
    return error
  }
}
