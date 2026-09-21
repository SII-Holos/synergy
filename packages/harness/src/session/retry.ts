import { RolloutRecordingError } from "./rollout/error"
import type { NamedError } from "@ericsanchezok/synergy-util/error"
import { MessageV2 } from "./message-v2"
import { retryAfterMs, retrySleep } from "@ericsanchezok/synergy-util/retry"
import { classifyNetworkError } from "@ericsanchezok/synergy-util/network-error"
import { providerRetryable } from "../provider/retry"

// Authoritative storage pressure rejects the request without corrupting it:
// the queue drains and the same turn succeeds. The persisted error is a
// serialized UnknownError whose message carries the original name, so the
// prefix is what identifies the condition here.
const STORAGE_BUSY_PREFIX = /^(?:Error: )?StorageBusyError(?::|$)/

export type RetryDecision = { message: string; maxAttempts: number }

export namespace SessionRetry {
  export const RETRY_INITIAL_DELAY = 2000
  export const RETRY_BACKOFF_FACTOR = 2
  export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
  export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout
  export const RETRY_MAX_ATTEMPTS = 10
  // An unmapped verification failure is indeterminate rather than proven transient, so its attempt
  // budget stays narrower than a classified transport failure's; backoff shares the transport ceiling.
  export const RETRY_TLS_VERIFICATION_MAX_ATTEMPTS = 6
  export const RETRY_TLS_VERIFICATION_MAX_DELAY = 30_000
  export const RETRY_TLS_VERIFICATION_MESSAGE = "Secure connection could not be verified; retrying"

  export const sleep = retrySleep

  function isTlsVerification(error?: MessageV2.APIError) {
    return error?.data.metadata?.category === "tls-verification"
  }

  export function delay(attempt: number, error?: MessageV2.APIError, random = Math.random) {
    const hint = retryAfterMs(error?.data.responseHeaders)
    if (hint !== undefined) return Math.min(hint, RETRY_MAX_DELAY)
    const ceiling = isTlsVerification(error) ? RETRY_TLS_VERIFICATION_MAX_DELAY : RETRY_MAX_DELAY_NO_HEADERS
    const maximum = Math.min(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), ceiling)
    return maximum * (0.5 + random() / 2)
  }

  export function retryable(error: ReturnType<NamedError["toObject"]>): RetryDecision | undefined {
    if (RolloutRecordingError.isInstance(error)) return undefined
    if (error.name !== "UnknownError" && !MessageV2.APIError.isInstance(error)) return undefined
    const rawMessage = typeof error?.data?.message === "string" ? error.data.message : ""
    if (error.name === "UnknownError" && /^(?:Error: )?Agent worker exited(?: \(|$)/.test(rawMessage))
      return { message: "Agent worker restarted", maxAttempts: RETRY_MAX_ATTEMPTS }
    if (error.name === "UnknownError" && STORAGE_BUSY_PREFIX.test(rawMessage))
      return { message: "Authoritative storage is busy; retrying", maxAttempts: RETRY_MAX_ATTEMPTS }

    if (MessageV2.APIError.isInstance(error)) {
      if (!error.data.isRetryable) return undefined
      if (isTlsVerification(error))
        return { message: RETRY_TLS_VERIFICATION_MESSAGE, maxAttempts: RETRY_TLS_VERIFICATION_MAX_ATTEMPTS }
      return {
        message: error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message,
        maxAttempts: RETRY_MAX_ATTEMPTS,
      }
    }

    if (classifyNetworkError(rawMessage)?.category === "tls-verification")
      return { message: RETRY_TLS_VERIFICATION_MESSAGE, maxAttempts: RETRY_TLS_VERIFICATION_MAX_ATTEMPTS }
    if (providerRetryable(rawMessage) === true)
      return { message: "Provider is temporarily unavailable", maxAttempts: RETRY_MAX_ATTEMPTS }
    return undefined
  }
}
