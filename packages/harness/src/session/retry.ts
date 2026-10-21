import { RolloutRecordingError } from "./rollout/error"
import type { NamedError } from "@ericsanchezok/synergy-util/error"
import { MessageV2 } from "./message-v2"
import { retryAfterMs, retrySleep } from "@ericsanchezok/synergy-util/retry"
import { classifyNetworkError } from "@ericsanchezok/synergy-util/network-error"
import { providerRetryable } from "../provider/retry"
import { RuntimeContext } from "../lifecycle/context"
import type { StatusInfo } from "./types"
import type { ProviderRecoveryWait } from "../provider/retry-coordinator"

// Authoritative storage pressure rejects the request without corrupting it:
// the queue drains and the same turn succeeds. The persisted error is a
// serialized UnknownError whose message carries the original name, so the
// prefix is what identifies the condition here.
const STORAGE_BUSY_PREFIX = /^(?:Error: )?StorageBusyError(?::|$)/

export type RetryDecision = { message: string; maxAttempts: number }

export namespace SessionRetry {
  type State = Extract<StatusInfo, { type: "retry" }>
  const controls = RuntimeContext.state(() => new Map<string, { messageID: string; retry(): boolean }>())
  const RETRY_DELAY_CEILINGS = [2_000, 4_000, 8_000, 16_000, 30_000, 60_000, 120_000] as const
  export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout
  export const RETRY_MAX_ATTEMPTS = 10
  export const RETRY_TLS_VERIFICATION_MESSAGE = "Secure connection could not be verified; retrying"

  export const sleep = retrySleep

  export function now(sessionID: string, messageID: string) {
    const control = controls().get(sessionID)
    return control?.messageID === messageID ? control.retry() : false
  }

  export function create(input: {
    sessionID: string
    rootID: string
    messageID: string
    providerID: string
    abort: AbortSignal
    publish(state: State): void
  }) {
    const pending = controls()
    let state: State | undefined
    let immediate = false
    let retry: (() => boolean) | undefined
    const control = { messageID: input.messageID, retry: () => !input.abort.aborted && (retry?.() ?? false) }
    function publish(value: State, action?: () => boolean) {
      if (input.abort.aborted) return
      state = value
      retry = action
      pending.set(input.sessionID, control)
      input.publish(value)
    }
    function connecting() {
      if (state) publish({ ...state, phase: "connecting", startedAt: Date.now(), next: undefined, canRetry: false })
    }
    function finish() {
      state = undefined
      retry = undefined
      if (pending.get(input.sessionID) === control) pending.delete(input.sessionID)
    }
    input.abort.addEventListener("abort", finish, { once: true })
    return {
      active: () => state !== undefined,
      takeImmediate() {
        const value = immediate
        immediate = false
        return value
      },
      async wait(error: ReturnType<NamedError["toObject"]>, attempt: number, delay: number) {
        input.abort.throwIfAborted()
        const apiError = MessageV2.APIError.isInstance(error) ? error : undefined
        const startedAt = Date.now()
        const wake = new AbortController()
        const canRetry = retryAfterMs(apiError?.data.responseHeaders) === undefined
        publish(
          {
            type: "retry",
            rootID: input.rootID,
            messageID: input.messageID,
            phase: "waiting",
            attempt,
            startedAt,
            next: startedAt + delay,
            canRetry,
            message:
              SessionRetry.retryable(error)?.message ??
              String("message" in error.data ? error.data.message : error.name),
            error: JSON.stringify(error, null, 2),
          },
          canRetry
            ? () => {
                if (wake.signal.aborted) return false
                immediate = true
                retry = undefined
                wake.abort()
                return true
              }
            : undefined,
        )
        try {
          await SessionRetry.sleep(delay, AbortSignal.any([input.abort, wake.signal]))
        } catch (error) {
          input.abort.throwIfAborted()
          if (!wake.signal.aborted) throw error
        }
        input.abort.throwIfAborted()
        connecting()
      },
      providerWait(wait: ProviderRecoveryWait | undefined) {
        if (!wait) return connecting()
        const error = MessageV2.fromError(wait.error, { providerID: input.providerID })
        publish(
          {
            type: "retry",
            rootID: input.rootID,
            messageID: input.messageID,
            phase: "waiting_provider",
            attempt: state?.attempt ?? 0,
            startedAt: Date.now(),
            next: wait.next,
            canRetry: !!wait.retry,
            message:
              SessionRetry.retryable(error)?.message ??
              String("message" in error.data ? error.data.message : error.name),
            error: JSON.stringify(error, null, 2),
          },
          wait.retry,
        )
      },
      finish,
      dispose() {
        input.abort.removeEventListener("abort", finish)
        finish()
      },
    }
  }

  function isTlsVerification(error?: MessageV2.APIError) {
    return error?.data.metadata?.category === "tls-verification"
  }

  export function delay(attempt: number, error?: MessageV2.APIError, random = Math.random) {
    const hint = retryAfterMs(error?.data.responseHeaders)
    if (hint !== undefined) return Math.min(hint, RETRY_MAX_DELAY)
    const maximum = RETRY_DELAY_CEILINGS[Math.min(attempt - 1, RETRY_DELAY_CEILINGS.length - 1)]!
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
      if (isTlsVerification(error)) return { message: RETRY_TLS_VERIFICATION_MESSAGE, maxAttempts: RETRY_MAX_ATTEMPTS }
      return {
        message: error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message,
        maxAttempts: RETRY_MAX_ATTEMPTS,
      }
    }

    if (classifyNetworkError(rawMessage)?.category === "tls-verification")
      return { message: RETRY_TLS_VERIFICATION_MESSAGE, maxAttempts: RETRY_MAX_ATTEMPTS }
    if (providerRetryable(rawMessage) === true)
      return { message: "Provider is temporarily unavailable", maxAttempts: RETRY_MAX_ATTEMPTS }
    return undefined
  }
}
