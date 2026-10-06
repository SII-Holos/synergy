import { classifyNetworkError } from "@ericsanchezok/synergy-util/network-error"
import { retry, type RetryOptions } from "@ericsanchezok/synergy-util/retry"

export type StorageServiceErrorState = "busy" | "unavailable"

export function storageServiceError(
  error: unknown,
): { state: StorageServiceErrorState; retryAfterMs: number; message?: string } | undefined {
  if (!error || typeof error !== "object" || !("name" in error) || error.name !== "StorageServiceError") return
  const data = "data" in error ? error.data : undefined
  if (!data || typeof data !== "object") return
  const state = "state" in data && (data.state === "busy" || data.state === "unavailable") ? data.state : undefined
  const retryAfterMs = "retryAfterMs" in data && typeof data.retryAfterMs === "number" ? data.retryAfterMs : undefined
  if (!state || retryAfterMs === undefined || !Number.isFinite(retryAfterMs) || retryAfterMs < 0) return
  return {
    state,
    retryAfterMs,
    message: "message" in data && typeof data.message === "string" ? data.message : undefined,
  }
}

export function retryStorageRequest<T>(fn: () => Promise<T>, options: { signal?: AbortSignal } = {}) {
  const retryOptions: RetryOptions = {
    attempts: 5,
    delay: 500,
    maxDelay: 5_000,
    signal: options.signal,
    retryIf: (error) => Boolean(storageServiceError(error)) || classifyNetworkError(error)?.kind === "transient",
    retryDelay: (error) => storageServiceError(error)?.retryAfterMs,
  }
  return retry(fn, retryOptions)
}

export function requestErrorMessage(error: unknown, fallback = "Request failed") {
  const storage = storageServiceError(error)
  if (storage) {
    return storage.state === "busy" ? "Storage is busy; retry shortly" : "Storage is recovering; retry shortly"
  }
  if (typeof error === "string" && error) return error
  if (error && typeof error === "object" && "data" in error) {
    const data = error.data
    if (data && typeof data === "object") {
      if ("message" in data && typeof data.message === "string" && data.message) return data.message
      if ("error" in data && typeof data.error === "string" && data.error) return data.error
    }
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = error.message
    if (typeof message === "string" && message) return message
  }
  return fallback
}
