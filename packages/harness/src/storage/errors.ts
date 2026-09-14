import { NamedError } from "@ericsanchezok/synergy-util/error"
import { z } from "zod"

export const NotFoundError = NamedError.create("NotFoundError", z.object({ message: z.string() }))

export class StorageConflictError extends Error {
  override readonly name = "StorageConflictError"
}

export class StorageClosedError extends Error {
  override readonly name = "StorageClosedError"
  constructor() {
    super("The authoritative store is closed")
  }
}

export class StorageIntegrityError extends Error {
  override readonly name = "StorageIntegrityError"
}

export class StorageOwnershipError extends Error {
  override readonly name = "StorageOwnershipError"
}

export class StorageCommitUnknownError extends Error {
  override readonly name = "StorageCommitUnknownError"
  constructor(
    readonly operationID: string | undefined,
    cause: unknown,
  ) {
    super("The database did not confirm the commit; reconcile the operation receipt before retrying", { cause })
  }
}

export class StorageBusyError extends Error {
  override readonly name = "StorageBusyError"
}

export function databaseErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return
  if ("errno" in error && typeof error.errno === "string" && /^[A-Z0-9]{5}$/.test(error.errno)) return error.errno
  return "code" in error ? String(error.code) : undefined
}
