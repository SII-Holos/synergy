import z from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { StorageBusyError, StorageClosedError } from "../../storage/errors"

export const RolloutRecordingError = NamedError.create("RolloutRecordingError", z.object({ message: z.string() }))

/** A deterministic admission failure: the queued task's experiment or the
 *  resolved execution configuration cannot produce a run, and retrying the
 *  same input will fail again. Materialization parks these instead of
 *  letting the queue retry forever. */
export const RolloutAdmissionError = NamedError.create("RolloutAdmissionError", z.object({ message: z.string() }))

function* causes(error: unknown): Generator<object> {
  const pending = [error]
  const visited = new Set<object>()
  for (let index = 0; index < pending.length && index < 64; index++) {
    const value = pending[index]
    if (!value || typeof value !== "object" || visited.has(value)) continue
    visited.add(value)
    yield value
    for (const key of ["cause", "error", "suppressed", "lastError"] as const) {
      if (key in value) pending.push((value as Record<string, unknown>)[key])
    }
    if ("errors" in value && Array.isArray(value.errors)) pending.push(...value.errors.slice(0, 64))
  }
}

export function findRecordingError(error: unknown): InstanceType<typeof RolloutRecordingError> | undefined {
  for (const value of causes(error)) if (RolloutRecordingError.isInstance(value)) return value
}

/** Storage pressure and store shutdown are environment conditions rather than
 *  evidence corruption: the same action can succeed after the queue drains or
 *  the Runtime restarts. They reach the caller as themselves because every
 *  consumer keys recovery off the recording-error class, so wrapping one would
 *  abort the live turn and disqualify the run's recording permanently. Mirrors
 *  the pass-through in `rollout/lifecycle.ts` and `session/input.ts`. */
export function isTransientStorageError(error: unknown): boolean {
  for (const value of causes(error))
    if (value instanceof StorageBusyError || value instanceof StorageClosedError) return true
  return false
}

export async function record<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action()
  } catch (cause) {
    const failure = findRecordingError(cause)
    if (failure) throw failure
    if (isTransientStorageError(cause)) throw cause
    throw new RolloutRecordingError({ message: "Unable to persist rollout evidence" }, { cause })
  }
}
