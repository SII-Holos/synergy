// Provenance: https://nodejs.org/docs/latest-v22.x/api/errors.html#common-system-errors
// https://github.com/nodejs/undici/blob/v6.21.3/docs/docs/api/Errors.md
// Local adaptation: classify bounded error graphs across runtimes; callers own replay safety and retry budgets.
const TRANSIENT_CODES = new Set([
  "CONNECTIONREFUSED",
  "CONNECTIONCLOSED",
  "FAILEDTOOPENSOCKET",
  "ETIMEOUT",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ESERVFAIL",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
])
const PERMANENT_CODES = new Set([
  "ENOTFOUND",
  "ENONAME",
  "EAI_NONAME",
  "ENODATA",
  "EBADNAME",
  "ERR_INVALID_URL",
  "ERR_CAUSE_TRUNCATED",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UND_ERR_INVALID_ARG",
  "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH",
  "UND_ERR_RES_EXCEEDED_MAX_SIZE",
])
const ABORT_CODES = new Set(["ABORT_ERR", "UND_ERR_ABORT", "UND_ERR_ABORTED", "ECANCELLED"])

// Provenance: https://www.rfc-editor.org/rfc/rfc5280
// Local adaptation: certificate wording without a reason code is reported as a distinct indeterminate
// kind so callers can apply a narrower retry budget than a proven transient failure.
const CERTIFICATE_MESSAGE = /\bcertificate\b/i
const VERIFICATION_MESSAGE = /\bverif/i

export function classifyNetworkError(error: unknown) {
  const seen = new Set<object>()
  let remaining = 32
  type Classification = {
    kind: "transient" | "permanent" | "aborted" | "indeterminate"
    code?: string
    syscall?: string
    category?: string
  }
  function visit(value: unknown, depth: number): Classification | undefined {
    if (depth > 8 || --remaining < 0) return { kind: "permanent" }
    if (!value || (typeof value !== "object" && typeof value !== "string")) return undefined
    if (typeof value === "object") {
      if (seen.has(value)) return undefined
      seen.add(value)
    }
    const record = typeof value === "object" ? (value as Record<string, unknown>) : undefined
    const message = typeof value === "string" ? value : typeof record?.message === "string" ? record.message : ""
    const code = typeof record?.code === "string" ? record.code : undefined
    const token =
      code?.toUpperCase() ?? message.match(/\b(?:E[A-Z_]+|UND_ERR_[A-Z_]+)\b/)?.[0] ?? message.trim().toUpperCase()
    const syscall = typeof record?.syscall === "string" ? record.syscall : undefined
    const name = record?.name
    let result: Classification | undefined
    if (name === "AbortError" || (token && ABORT_CODES.has(token))) result = { kind: "aborted", code, syscall }
    else if (
      (token && (PERMANENT_CODES.has(token) || /^(ERR_TLS_|ERR_SSL_)/.test(token))) ||
      /certificate (?:has expired|verify failed|verification failed)|self[- ]signed certificate|unable to verify (?:the )?first certificate/i.test(
        message,
      )
    ) {
      result = { kind: "permanent", code, syscall }
    } else if (!code && CERTIFICATE_MESSAGE.test(message) && VERIFICATION_MESSAGE.test(message)) {
      result = { kind: "indeterminate", code, syscall, category: "tls-verification" }
    } else if (token && TRANSIENT_CODES.has(token)) result = { kind: "transient", code: code ?? token, syscall }
    else if (
      name === "TimeoutError" ||
      /^(?:(?:TypeError|Error): )?(?:fetch failed(?:: failed to fetch)?|failed to fetch|load failed|network error|connection error|(?:the )?network request failed|(?:the )?network connection was lost|socket hang up|NetworkError when attempting to fetch resource|The Internet connection appears to be offline)\.?$/i.test(
        message,
      ) ||
      /^The socket connection was closed unexpectedly\./i.test(message) ||
      /unable to connect\. is the computer able to access the url\?/i.test(message)
    ) {
      result = { kind: "transient", code, syscall }
    }
    const children = [record?.cause, ...(Array.isArray(record?.errors) ? record.errors.slice(0, 33) : [])]
    for (const child of children) {
      if (child === undefined) continue
      const nested = visit(child, depth + 1)
      if (!nested) continue
      if (nested.kind === "aborted") return nested
      if (result?.kind === "aborted") return result
      if (
        nested.kind === "permanent" ||
        !result ||
        (result.kind === "transient" && (nested.code || nested.kind === "indeterminate"))
      )
        result = nested
    }
    return result
  }
  return visit(error, 0)
}

// Provenance: https://www.rfc-editor.org/rfc/rfc9110.html#section-15
// Local adaptation: transient HTTP reads exclude unsupported server capabilities; provider-specific conflicts stay with the SDK.
export function isRetryableHttpStatus(status: number) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599 && status !== 501 && status !== 505)
}
