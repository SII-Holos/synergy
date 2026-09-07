import z from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"

export const RolloutRecordingError = NamedError.create("RolloutRecordingError", z.object({ message: z.string() }))

export function findRecordingError(error: unknown): InstanceType<typeof RolloutRecordingError> | undefined {
  const pending = [error]
  const visited = new Set<object>()
  for (let index = 0; index < pending.length && index < 64; index++) {
    const value = pending[index]
    if (!value || typeof value !== "object" || visited.has(value)) continue
    visited.add(value)
    if (RolloutRecordingError.isInstance(value)) return value
    for (const key of ["cause", "error", "suppressed", "lastError"] as const) {
      if (key in value) pending.push((value as Record<string, unknown>)[key])
    }
    if ("errors" in value && Array.isArray(value.errors)) pending.push(...value.errors.slice(0, 64))
  }
}

export async function record<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action()
  } catch (cause) {
    const failure = findRecordingError(cause)
    if (failure) throw failure
    throw new RolloutRecordingError({ message: "Unable to persist rollout evidence" }, { cause })
  }
}
