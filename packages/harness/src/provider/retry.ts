import { APICallError } from "ai"
import { classifyNetworkError, isRetryableHttpStatus } from "@ericsanchezok/synergy-util/network-error"
import { findRecordingError } from "../session/rollout/error"
import { NamedError } from "@ericsanchezok/synergy-util/error"

// Provenance: https://github.com/openai/codex/blob/2f05c0a71f59fb2f05800846351f3e9926c3e52b/codex-rs/codex-api/src/sse/responses_error.rs
// Provenance: https://github.com/openai/codex/blob/2f05c0a71f59fb2f05800846351f3e9926c3e52b/codex-rs/protocol/src/error.rs
// Local adaptation: share explicit Codex categories and exact capacity wording; unknown errors stay terminal and caller retry budgets remain unchanged.
const TRANSIENT_CODES = new Set([
  "too_many_requests",
  "rate_limit_exceeded",
  "rate_limit_error",
  "overloaded_error",
  "server_is_overloaded",
  "server_overloaded",
  "service_unavailable_error",
  "slow_down",
  "server_error",
  "api_error",
  "service_unavailable",
  "unavailable",
  "resource_exhausted",
  "no_kv_space",
])
const TERMINAL_CODES = new Set([
  "insufficient_quota",
  "usage_limit_reached",
  "usage_not_included",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "billing_hard_limit_reached",
  "personal-team-blocked:spending-limit",
  "invalid_api_key",
  "authentication_error",
  "permission_error",
  "invalid_request_error",
  "not_found_error",
  "context_length_exceeded",
  "invalid_prompt",
  "cyber_policy",
  "bio_policy",
  "misalignment_policy_violation",
])

// Message-only fallback is exact; a provider's structured terminal refusal takes precedence.
const TRANSIENT_MESSAGES = new Set([
  "our servers are currently overloaded. please try again later.",
  "selected model is at capacity. please try a different model.",
])

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

export function providerRetryable(error: unknown): boolean | undefined {
  if (findRecordingError(error)) return false
  const network = classifyNetworkError(error)
  if (network && network.kind !== "transient" && network.kind !== "indeterminate") return false
  const source = record(error)
  if (source?.name === "AI_RetryError") return false
  let payload = source
  const message = typeof error === "string" ? error : source?.message
  if (typeof message === "string") {
    try {
      payload = record(JSON.parse(message)) ?? payload
    } catch {}
  }
  let body: Record<string, unknown> | undefined
  if (typeof source?.responseBody === "string") {
    try {
      body = record(JSON.parse(source.responseBody))
    } catch {}
  }
  const entries = [source, payload, body].flatMap((entry) => [
    entry,
    record(entry?.error),
    record(record(entry?.response)?.error),
  ])
  const codes = entries
    .flatMap((entry) => [entry?.code, entry?.type])
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase())
  if (codes.some((code) => TERMINAL_CODES.has(code))) return false
  if (
    [message, source?.responseBody].some(
      (value) => typeof value === "string" && /\bpersonal-team-blocked:spending-limit\b/i.test(value),
    )
  )
    return false
  const status = source?.statusCode
  if (typeof status === "number" && status >= 400) {
    if (isRetryableHttpStatus(status)) return true
    return status === 409 && source?.isRetryable === true
  }
  if (codes.some((code) => TRANSIENT_CODES.has(code))) return true
  if (source?.name === "AI_InvalidResponseDataError" && message === "Response stream ended without a finish reason.")
    return true
  if (
    [message, ...entries.map((entry) => entry?.message)].some(
      (value) =>
        typeof value === "string" &&
        TRANSIENT_MESSAGES.has(
          value
            .trim()
            .replace(/^Error:\s*/, "")
            .toLowerCase(),
        ),
    )
  )
    return true
  if (entries.some((entry) => typeof entry?.message === "string" && /\bno_kv_space\b/i.test(entry.message))) return true
  if (network?.kind === "transient" || network?.kind === "indeterminate") return true
  return typeof source?.isRetryable === "boolean" ? source.isRetryable : undefined
}

// Provenance: https://github.com/vercel/ai/blob/ai%405.0.212/packages/ai/src/util/retry-with-exponential-backoff.ts
// Local adaptation: normalize transport failures before SDK retry admission; no nested retry loop or stream replay is added.
export function normalizeProviderError(error: unknown) {
  const recording = findRecordingError(error)
  if (recording) return recording
  if (error instanceof NamedError) return error
  if (classifyNetworkError(error)?.kind === "aborted") return error
  const isRetryable = providerRetryable(error)
  if (isRetryable === undefined) return error
  if (APICallError.isInstance(error)) {
    if (error.isRetryable === isRetryable) return error
    const result = new APICallError({ ...error, message: error.message, cause: error.cause, isRetryable })
    result.stack = error.stack
    return result
  }
  const source = record(error)
  const headers = record(source?.responseHeaders)
  return new APICallError({
    message: typeof source?.message === "string" ? source.message : String(error),
    statusCode:
      typeof source?.statusCode === "number" && Number.isInteger(source.statusCode) ? source.statusCode : undefined,
    responseHeaders: headers
      ? Object.fromEntries(
          Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        )
      : undefined,
    responseBody: typeof source?.responseBody === "string" ? source.responseBody : undefined,
    url: "",
    requestBodyValues: {},
    isRetryable,
    cause: error,
  })
}
