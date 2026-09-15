import { RolloutRecordingError } from "./rollout/error"
import type { NamedError } from "@ericsanchezok/synergy-util/error"
import { MessageV2 } from "./message-v2"
import { retryAfterMs, retrySleep } from "@ericsanchezok/synergy-util/retry"
import { providerRetryable } from "../provider/retry"

export namespace SessionRetry {
  export const RETRY_INITIAL_DELAY = 2000
  export const RETRY_BACKOFF_FACTOR = 2
  export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
  export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout
  export const RETRY_MAX_ATTEMPTS = 10

  export const sleep = retrySleep

  export function delay(attempt: number, error?: MessageV2.APIError, random = Math.random) {
    const hint = retryAfterMs(error?.data.responseHeaders)
    if (hint !== undefined) return Math.min(hint, RETRY_MAX_DELAY)
    const maximum = Math.min(
      RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1),
      RETRY_MAX_DELAY_NO_HEADERS,
    )
    return maximum * (0.5 + random() / 2)
  }

  export function retryable(error: ReturnType<NamedError["toObject"]>) {
    if (RolloutRecordingError.isInstance(error)) return undefined
    if (error.name !== "UnknownError" && !MessageV2.APIError.isInstance(error)) return undefined
    const rawMessage = typeof error?.data?.message === "string" ? error.data.message : ""
    if (error.name === "UnknownError" && /^(?:Error: )?Agent worker exited(?: \(|$)/.test(rawMessage))
      return "Agent worker restarted"

    if (MessageV2.APIError.isInstance(error)) {
      if (!error.data.isRetryable) return undefined
      return error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message
    }

    if (providerRetryable(rawMessage) === true) return "Provider is temporarily unavailable"
    return undefined
  }
}
