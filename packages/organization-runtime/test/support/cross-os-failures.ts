import { ObservabilityRedaction } from "@ericsanchezok/synergy-harness/observability/redaction"
import { safeCrossOSFailure } from "./cross-os-transport"

export function createTargetPreparationObservation() {
  const failures: Array<{
    operation: "prepare-target"
    signalAborted: boolean
    error: ReturnType<typeof safeCrossOSFailure>
  }> = []
  return {
    observe<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
      void pending.catch((error: unknown) => {
        try {
          if (failures.length < 4)
            failures.push({
              operation: "prepare-target",
              signalAborted: signal.aborted,
              error: safeCrossOSFailure(error),
            })
        } catch {}
      })
      return pending
    },
    snapshot(): Readonly<typeof failures> {
      return structuredClone(failures)
    },
  }
}

export type HeaderFailure = {
  name: string
  code?: string
  message?: string
  syscall?: string
  errnoCategory?: string
  hostnameMatches?: boolean
  cause?: HeaderFailure
}
export type HeaderFailureSample<Cache> = {
  attempt: number | null
  observedAtMs: number
  elapsedBeforeFailureMs: number
  fetchInvoked: boolean
  dnsCache: Cache
  failure: HeaderFailure
}
export type HeaderFailureKindSample<Cache> = HeaderFailureSample<Cache> & { kind: string }

function field(value: unknown, name: string): unknown {
  try {
    if (typeof value !== "object" || value === null) return
    const descriptor = Object.getOwnPropertyDescriptor(value, name)
    return descriptor && "value" in descriptor ? descriptor.value : undefined
  } catch {}
}
export function safeCrossOSTransportText(value: string, hostnames: string[] = []) {
  const bounded = value.slice(0, 2048)
  const input = value.length > 2048 ? bounded.replace(/\S+$/, "[truncated-token]") : bounded
  let text = ObservabilityRedaction.text(input, Number.POSITIVE_INFINITY)
  for (const hostname of hostnames) if (hostname) text = text.replaceAll(hostname, "[hostname]")
  return text
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/\/(?:Users\/runner|home\/runner|private\/var\/folders|var\/folders|tmp)\/[^\s"'<>]+/g, "[runner-path]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "[ip]")
    .replace(/\[[0-9a-f:.]+(?:%[a-z0-9_.-]+)?\](?::\d+)?/gi, "[ip]")
    .replace(/\b(?:[0-9a-f]{0,4}:){2,}[0-9a-f:.]+(?:%[a-z0-9_.-]+)?/gi, "[ip]")
    .replace(/::[0-9a-f][0-9a-f:.]*(?:%[a-z0-9_.-]+)?/gi, "[ip]")
    .replace(/\b[a-z0-9-]+\.trycloudflare\.com\b/gi, "[hostname]")
    .replace(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}\b/gi, "[hostname]")
    .slice(0, 512)
}
const syscalls = new Set(["getaddrinfo", "connect", "getnameinfo", "queryA", "queryAAAA", "send", "recv"])
const errnos = new Set([
  "ENOTFOUND",
  "EAI_NONAME",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ETIMEOUT",
  "ECANCELED",
  "ECANCELLED",
  "ABORT_ERR",
])
function errnoCategory(value: unknown) {
  if (typeof value === "string") return errnos.has(value) ? value : "other-string"
  if (typeof value === "number")
    return Number.isInteger(value)
      ? value < 0
        ? "negative-integer"
        : value === 0
          ? "zero"
          : "positive-integer"
      : "other-number"
  return "other"
}
export function safeCrossOSHeaderFailure(value: unknown, capturedHostname: string, depth = 0): HeaderFailure {
  const safe = safeCrossOSFailure(value)
  const message = typeof value === "string" ? value : field(value, "message")
  const syscall = field(value, "syscall")
  const errno = field(value, "errno")
  const hostname = field(value, "hostname")
  const cause = field(value, "cause")
  return {
    name: safe.name,
    ...(safe.code === undefined ? {} : { code: safe.code }),
    ...(typeof message === "string"
      ? {
          message: safeCrossOSTransportText(message, [
            capturedHostname,
            ...(typeof hostname === "string" ? [hostname] : []),
          ]),
        }
      : {}),
    ...(typeof syscall === "string" ? { syscall: syscalls.has(syscall) ? syscall : "other" } : {}),
    ...(errno === undefined ? {} : { errnoCategory: errnoCategory(errno) }),
    ...(typeof hostname === "string"
      ? { hostnameMatches: hostname.toLowerCase() === capturedHostname.toLowerCase() }
      : {}),
    ...(cause === undefined || depth >= 2
      ? {}
      : { cause: safeCrossOSHeaderFailure(cause, capturedHostname, depth + 1) }),
  }
}
export function isOriginalHeaderTimeout(
  value: unknown,
  failure: HeaderFailure,
  timeouts: Array<AbortSignal | undefined>,
) {
  return (
    (value instanceof Error && failure.name === "TimeoutError") ||
    timeouts.some((signal) => signal?.aborted && signal.reason === value)
  )
}
export function recordCrossOSHeaderFailure<Cache>(
  facts: {
    firstHeaderFailures: HeaderFailureSample<Cache>[]
    firstFailureKinds: HeaderFailureKindSample<Cache>[]
    failureKinds: Record<string, number>
  },
  failure: HeaderFailure,
  observe: () => Omit<HeaderFailureSample<Cache>, "failure">,
) {
  const kind = [
    failure.name,
    failure.code ?? "no-code",
    failure.cause?.name ?? "no-cause",
    failure.cause?.code ?? "no-code",
  ].join(":")
  const category =
    Object.hasOwn(facts.failureKinds, kind) || Object.keys(facts.failureKinds).length < 16 ? kind : "other"
  const first = facts.firstHeaderFailures.length < 4
  const firstKind =
    category !== "other" &&
    facts.firstFailureKinds.length < 16 &&
    !facts.firstFailureKinds.some((entry) => entry.kind === category)
  let sample: HeaderFailureSample<Cache> | undefined
  if (first) {
    sample = { ...observe(), failure }
    facts.firstHeaderFailures.push(sample)
  }
  facts.failureKinds[category] = (facts.failureKinds[category] ?? 0) + 1
  if (firstKind) {
    sample ??= { ...observe(), failure }
    facts.firstFailureKinds.push({ ...sample, kind: category })
  }
}
