import { Resolver } from "node:dns/promises"
import { isIP } from "node:net"
import { setTimeout as delay } from "node:timers/promises"

type FailedHealthResolver = {
  resolve4(hostname: string, options: { ttl: true }): Promise<unknown>
  resolve6(hostname: string, options: { ttl: true }): Promise<unknown>
  cancel(): void
}
const dnsCodes = new Set([
  "ENODATA",
  "EFORMERR",
  "ESERVFAIL",
  "ENOTFOUND",
  "ENOTIMP",
  "EREFUSED",
  "EBADQUERY",
  "EBADNAME",
  "EBADFAMILY",
  "EBADRESP",
  "ECONNREFUSED",
  "ETIMEOUT",
  "ETIMEDOUT",
  "EOF",
  "EFILE",
  "ENOMEM",
  "EDESTRUCTION",
  "EBADSTR",
  "EBADFLAGS",
  "ENONAME",
  "ECANCELLED",
])
function field(value: unknown, name: string): unknown {
  try {
    if (typeof value !== "object" || value === null) return
    const descriptor = Object.getOwnPropertyDescriptor(value, name)
    return descriptor && "value" in descriptor ? descriptor.value : undefined
  } catch {}
}
function errorCode(error: unknown) {
  const code = field(error, "code")
  return typeof code === "string" && dnsCodes.has(code) ? code : "OTHER"
}
function records(value: unknown) {
  const count = field(value, "length")
  if (!Array.isArray(value) || typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > 65535)
    return { code: "INVALID_RESULT", count: 0 }
  let ttlCount = 0,
    ttlMin = Infinity,
    ttlMax = 0
  for (let index = 0; index < count; index++) {
    const ttl = field(field(value, String(index)), "ttl")
    if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 0 || ttl > 4294967295) continue
    ttlCount++
    ttlMin = Math.min(ttlMin, ttl)
    ttlMax = Math.max(ttlMax, ttl)
  }
  return { code: "OK", count, ttlCount, ...(ttlCount ? { ttlMin, ttlMax } : {}) }
}

// Provenance: https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/src/js/node/dns.ts
// https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/src/runtime/dns_jsc/dns.rs
// https://c-ares.org/docs/ares_cancel.html
// Local adaptation: compare only after original failure; cancel this independent channel and retain no address values.
export async function observeDNSAfterFailedHealth(
  origin: string,
  originalENOTFOUND: number,
  createResolver: (options: { timeout: number; tries: number }) => FailedHealthResolver = (options) =>
    new Resolver(options),
) {
  if (!Number.isSafeInteger(originalENOTFOUND) || originalENOTFOUND <= 0) return
  const started = performance.now()
  const baseline = {
    timing: "after-original-failure" as const,
    sampling: "non-simultaneous" as const,
    systemBaseline: {
      source: "original-public-health" as const,
      code: "ENOTFOUND" as const,
      count: originalENOTFOUND,
    },
  }
  let resolver: FailedHealthResolver, hostname: string
  try {
    const url = new URL(origin)
    if (url.protocol !== "https:" || url.origin !== origin || !/^[a-z0-9-]+\.trycloudflare\.com$/.test(url.hostname))
      return { ...baseline, available: false, code: "INVALID_ORIGIN", elapsedMs: performance.now() - started }
    hostname = url.hostname
    resolver = createResolver({ timeout: 250, tries: 1 })
  } catch (error) {
    return { ...baseline, available: false, code: errorCode(error), elapsedMs: performance.now() - started }
  }
  type Observation = ReturnType<typeof records> & { elapsedMs: number }
  const answers: { A?: Observation; AAAA?: Observation } = {}
  let cancelCalled = false,
    cancelError: string | undefined
  const deadline = Promise.withResolvers<void>()
  const cancelTimer = setTimeout(
    () => {
      cancelCalled = true
      try {
        resolver.cancel()
      } catch (error) {
        cancelError = errorCode(error)
      }
    },
    Math.max(0, 500 - (performance.now() - started)),
  )
  const deadlineTimer = setTimeout(() => deadline.resolve(), Math.max(0, 750 - (performance.now() - started)))
  async function query(family: "A" | "AAAA") {
    const queryStarted = performance.now()
    try {
      const value = await (family === "A"
        ? resolver.resolve4(hostname, { ttl: true })
        : resolver.resolve6(hostname, { ttl: true }))
      answers[family] = { ...records(value), elapsedMs: performance.now() - queryStarted }
    } catch (error) {
      answers[family] = { code: errorCode(error), count: 0, elapsedMs: performance.now() - queryStarted }
    }
  }
  try {
    await Promise.race([Promise.all([query("A"), query("AAAA")]), deadline.promise])
  } finally {
    clearTimeout(cancelTimer)
    clearTimeout(deadlineTimer)
  }
  const elapsedMs = performance.now() - started
  return {
    ...baseline,
    available: true,
    elapsedMs,
    cancelCalled,
    ...(cancelError === undefined ? {} : { cancelError }),
    queriesSettled: answers.A !== undefined && answers.AAAA !== undefined,
    A: answers.A ?? { code: "UNSETTLED", count: 0, elapsedMs },
    AAAA: answers.AAAA ?? { code: "UNSETTLED", count: 0, elapsedMs },
  }
}

type DNSFieldKind = "data" | "accessor" | "missing" | "nonobject" | "unavailable"
type DNSStage = "not-started" | "resolver-create" | "queries" | "delay" | "cancel" | "drain" | "ready" | "failed"
type DNSFailure = {
  thrownType: string
  nativeClass: "error" | "aggregate" | "dom-exception" | "other" | "unavailable"
  originalAbort: boolean
  nameShape: DNSFieldKind
  codeShape: DNSFieldKind
  causeShape: DNSFieldKind
  aggregateShape: DNSFieldKind
  name?: string
  code: string
  syscall?: string
  errnoCategory?: string
  hostnameMatches?: boolean
  cause?: DNSFailure
  errors?: DNSFailure[]
  aggregateOverflow?: number
  aggregateReadUnavailable?: boolean
}
type DNSQuerySample = {
  pair: number
  code: string
  elapsedMs: number
  stage: "query" | "parse"
  returnedLength?: number
  validAddressCount?: number
  shape?: {
    lengthKind: DNSFieldKind
    entries: { object: number; string: number; null: number; other: number }
    address: Record<DNSFieldKind, number>
    addressStrings: number
    otherFamily: number
    invalidString: number
  }
  error?: DNSFailure
}
function dnsField(value: unknown, name: string): { kind: DNSFieldKind; value: unknown } {
  try {
    if (typeof value !== "object" || value === null) return { kind: "nonobject", value: undefined }
    const descriptor = Object.getOwnPropertyDescriptor(value, name)
    if (!descriptor) return { kind: "missing", value: undefined }
    return "value" in descriptor ? { kind: "data", value: descriptor.value } : { kind: "accessor", value: undefined }
  } catch {
    return { kind: "unavailable", value: undefined }
  }
}
const dnsNames = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "AggregateError",
  "DOMException",
  "AbortError",
  "TimeoutError",
])
const dnsSyscalls = new Set(["queryA", "queryAAAA", "getaddrinfo", "getnameinfo", "connect", "send", "recv"])
function dnsFailure(error: unknown, signal: AbortSignal, hostname: string, depth = 0): DNSFailure {
  const name = dnsField(error, "name"),
    code = dnsField(error, "code")
  const cause = dnsField(error, "cause"),
    errors = dnsField(error, "errors")
  const result: DNSFailure = {
    thrownType: typeof error,
    nativeClass: "other",
    originalAbort: signal.aborted && signal.reason === error,
    nameShape: name.kind,
    codeShape: code.kind,
    causeShape: cause.kind,
    aggregateShape: errors.kind,
    code: typeof code.value === "string" && dnsCodes.has(code.value) ? code.value : "OTHER",
  }
  try {
    result.nativeClass =
      error instanceof AggregateError
        ? "aggregate"
        : typeof DOMException === "function" && error instanceof DOMException
          ? "dom-exception"
          : error instanceof Error
            ? "error"
            : "other"
  } catch {
    result.nativeClass = "unavailable"
  }
  if (typeof name.value === "string" && dnsNames.has(name.value)) result.name = name.value
  const syscall = dnsField(error, "syscall").value
  if (typeof syscall === "string") result.syscall = dnsSyscalls.has(syscall) ? syscall : "other"
  const errno = dnsField(error, "errno").value
  if (typeof errno === "string") result.errnoCategory = dnsCodes.has(errno) ? errno : "other-string"
  else if (typeof errno === "number")
    result.errnoCategory = Number.isInteger(errno)
      ? errno === 0
        ? "zero"
        : errno < 0
          ? "negative-integer"
          : "positive-integer"
      : "other-number"
  const host = dnsField(error, "hostname").value
  if (typeof host === "string") result.hostnameMatches = host.toLowerCase() === hostname.toLowerCase()
  if (depth === 0) {
    if (cause.kind === "data" && cause.value !== undefined) result.cause = dnsFailure(cause.value, signal, hostname, 1)
    let aggregate = false
    try {
      aggregate = Array.isArray(errors.value)
    } catch {
      result.aggregateReadUnavailable = true
    }
    if (aggregate) {
      const length = dnsField(errors.value, "length").value
      if (typeof length === "number" && Number.isSafeInteger(length) && length >= 0) {
        result.errors = []
        for (let index = 0; index < Math.min(length, 2); index++) {
          const item = dnsField(errors.value, String(index))
          if (item.kind === "data") result.errors.push(dnsFailure(item.value, signal, hostname, 1))
        }
        if (length > 2) result.aggregateOverflow = length - 2
      }
    }
  }
  return result
}
export function createPublicDNSObservation() {
  function family() {
    return {
      invocations: 0,
      settled: 0,
      positiveParsedResults: 0,
      zeroParsedResults: 0,
      codes: {} as Record<string, number>,
      first: undefined as DNSQuerySample | undefined,
      last: undefined as DNSQuerySample | undefined,
      firstPositive: undefined as DNSQuerySample | undefined,
    }
  }
  return {
    started: false,
    stage: "not-started" as DNSStage,
    pairsStarted: 0,
    pairsCompletedBeforeDecision: 0,
    cancelCalled: false,
    cancelReturned: false,
    pairDrained: false,
    originalSignalAborted: false,
    elapsedMs: 0,
    failureStage: undefined as DNSStage | undefined,
    failure: undefined as DNSFailure | undefined,
    cancelFailure: undefined as DNSFailure | undefined,
    A: family(),
    AAAA: family(),
  }
}

// Provenance: https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/
// Bun 1.4.3 bun-types/bun.d.ts DNS backend contract; node:dns Resolver uses independent default servers.
// Local adaptation: qualify the temporary name before ordinary HTTP, retaining the original bootstrap signal and route.
export async function waitForPublicDNS(
  origin: string,
  signal: AbortSignal,
  createResolver: (options: { timeout: number; tries: number }) => FailedHealthResolver = (options) =>
    new Resolver(options),
  facts?: ReturnType<typeof createPublicDNSObservation>,
) {
  signal.throwIfAborted()
  const url = new URL(origin)
  if (url.protocol !== "https:" || url.origin !== origin || !/^[a-z0-9-]+\.trycloudflare\.com$/.test(url.hostname))
    throw new Error("Public DNS readiness requires the original temporary tunnel origin")
  const started = performance.now()
  if (facts) {
    facts.started = true
    facts.stage = "resolver-create"
  }
  let resolver: FailedHealthResolver
  try {
    resolver = createResolver({ timeout: 250, tries: 1 })
  } catch (error) {
    if (facts) {
      facts.failureStage = facts.stage
      facts.failure = dnsFailure(error, signal, url.hostname)
      facts.stage = "failed"
      facts.elapsedMs = performance.now() - started
    }
    throw error
  }
  const aborted = Promise.withResolvers<never>()
  const onAbort = () => aborted.reject(signal.reason)
  signal.addEventListener("abort", onAbort, { once: true })
  let pending: Promise<[PromiseSettledResult<number>, PromiseSettledResult<number>]> | undefined
  let failure: { error: unknown } | undefined
  let ready: { attempts: number; A: number; AAAA: number; elapsedMs: number } | undefined
  let positiveAttempt: number | undefined
  async function query(family: 4 | 6, positive: () => void) {
    const selected = facts?.[family === 4 ? "A" : "AAAA"]
    const queryStarted = facts ? performance.now() : 0
    let stage: "query" | "parse" = "query"
    if (selected) selected.invocations++
    function record(sample: Omit<DNSQuerySample, "elapsedMs" | "pair" | "stage">) {
      if (!selected || !facts) return
      const value = { ...sample, pair: facts.pairsStarted, stage, elapsedMs: performance.now() - queryStarted }
      const code =
        dnsCodes.has(value.code) || ["OK", "EMPTY_RESULT", "INVALID_RESULT"].includes(value.code) ? value.code : "OTHER"
      selected.codes[code] = (selected.codes[code] ?? 0) + 1
      selected.first ??= value
      selected.last = value
      if (value.validAddressCount !== undefined) {
        if (value.validAddressCount > 0) {
          selected.positiveParsedResults++
          selected.firstPositive ??= value
        } else selected.zeroParsedResults++
      }
    }
    try {
      const value = await (family === 4
        ? resolver.resolve4(url.hostname, { ttl: true })
        : resolver.resolve6(url.hostname, { ttl: true }))
      stage = "parse"
      const lengthField = dnsField(value, "length")
      const length = lengthField.value
      if (
        !Array.isArray(value) ||
        typeof length !== "number" ||
        !Number.isInteger(length) ||
        length < 0 ||
        length > 65535
      )
        throw new Error("Public DNS readiness returned invalid records")
      const shape: NonNullable<DNSQuerySample["shape"]> = {
        lengthKind: lengthField.kind,
        entries: { object: 0, string: 0, null: 0, other: 0 },
        address: { data: 0, accessor: 0, missing: 0, nonobject: 0, unavailable: 0 },
        addressStrings: 0,
        otherFamily: 0,
        invalidString: 0,
      }
      let count = 0
      for (let index = 0; index < length; index++) {
        const item = dnsField(value, String(index)).value
        const kind =
          item === null ? "null" : typeof item === "string" ? "string" : typeof item === "object" ? "object" : "other"
        shape.entries[kind]++
        const address = dnsField(item, "address")
        shape.address[address.kind]++
        if (typeof address.value === "string") {
          shape.addressStrings++
          const actualFamily = isIP(address.value)
          if (actualFamily === family) count++
          else if (actualFamily === 0) shape.invalidString++
          else shape.otherFamily++
        }
      }
      record({ code: count > 0 ? "OK" : "EMPTY_RESULT", returnedLength: length, validAddressCount: count, shape })
      if (count > 0) positive()
      return count
    } catch (error) {
      const code = errorCode(error)
      record({ code: stage === "parse" ? "INVALID_RESULT" : code, error: dnsFailure(error, signal, url.hostname) })
      if (!dnsCodes.has(code)) throw error
      return 0
    } finally {
      if (selected) selected.settled++
    }
  }
  try {
    signal.throwIfAborted()
    for (let attempts = 1; ; attempts++) {
      const positive = Promise.withResolvers<void>()
      if (facts) {
        facts.stage = "queries"
        facts.pairsStarted++
      }
      pending = Promise.allSettled([query(4, positive.resolve), query(6, positive.resolve)])
      const result = await Promise.race([
        pending.then((values) => ({ kind: "settled" as const, values })),
        positive.promise.then(() => ({ kind: "positive" as const })),
        aborted.promise,
      ])
      signal.throwIfAborted()
      if (result.kind === "positive") {
        positiveAttempt = attempts
        break
      }
      const [v4, v6] = result.values
      if (facts) facts.pairsCompletedBeforeDecision++
      if (v4.status === "rejected" && v6.status === "rejected")
        throw new AggregateError([v4.reason, v6.reason], "Both public DNS readiness queries failed")
      if (v4.status === "rejected") throw v4.reason
      if (v6.status === "rejected") throw v6.reason
      const A = v4.value
      const AAAA = v6.value
      if (A > 0 || AAAA > 0) {
        ready = { attempts, A, AAAA, elapsedMs: performance.now() - started }
        break
      }
      if (facts) facts.stage = "delay"
      await delay(250, undefined, { signal })
    }
  } catch (error) {
    failure = { error: signal.aborted ? signal.reason : error }
    if (facts) facts.failureStage = facts.stage
  } finally {
    signal.removeEventListener("abort", onAbort)
    let cancellation: { error: unknown } | undefined
    if (facts) {
      facts.stage = "cancel"
      facts.cancelCalled = true
    }
    try {
      resolver.cancel()
      if (facts) facts.cancelReturned = true
    } catch (error) {
      cancellation = { error }
      if (facts) facts.cancelFailure = dnsFailure(error, signal, url.hostname)
    }
    if (facts) facts.stage = "drain"
    const values = await pending
    if (facts) facts.pairDrained = pending !== undefined
    if (positiveAttempt !== undefined && !failure) {
      try {
        signal.throwIfAborted()
        if (!values) throw new Error("Public DNS readiness has no original query pair")
        const [v4, v6] = values
        if (v4.status === "rejected" && v6.status === "rejected")
          throw new AggregateError([v4.reason, v6.reason], "Both public DNS readiness queries failed")
        if (v4.status === "rejected") throw v4.reason
        if (v6.status === "rejected") throw v6.reason
        ready = { attempts: positiveAttempt, A: v4.value, AAAA: v6.value, elapsedMs: performance.now() - started }
      } catch (error) {
        failure = { error: signal.aborted ? signal.reason : error }
        if (facts) facts.failureStage = "drain"
      }
    }
    if (cancellation)
      failure = {
        error: failure
          ? new AggregateError(
              [failure.error, cancellation.error],
              "Public DNS readiness and its owned cancellation failed",
            )
          : cancellation.error,
      }
    if (facts) {
      if (cancellation) facts.failureStage ??= "cancel"
      facts.failure = failure ? dnsFailure(failure.error, signal, url.hostname) : undefined
      facts.originalSignalAborted = signal.aborted
      facts.elapsedMs = performance.now() - started
      facts.stage = failure ? "failed" : "ready"
    }
  }
  if (failure) throw failure.error
  if (!ready) throw new Error("Public DNS readiness ended without a positive response")
  return ready
}
