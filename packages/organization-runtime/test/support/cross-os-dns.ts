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

// Provenance: https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/
// Bun 1.4.3 bun-types/bun.d.ts DNS backend contract; node:dns Resolver uses independent default servers.
// Local adaptation: qualify the temporary name before ordinary HTTP, retaining the original bootstrap signal and route.
export async function waitForPublicDNS(
  origin: string,
  signal: AbortSignal,
  createResolver: (options: { timeout: number; tries: number }) => FailedHealthResolver = (options) =>
    new Resolver(options),
) {
  signal.throwIfAborted()
  const url = new URL(origin)
  if (url.protocol !== "https:" || url.origin !== origin || !/^[a-z0-9-]+\.trycloudflare\.com$/.test(url.hostname))
    throw new Error("Public DNS readiness requires the original temporary tunnel origin")
  const started = performance.now()
  const resolver = createResolver({ timeout: 250, tries: 1 })
  const aborted = Promise.withResolvers<never>()
  const onAbort = () => aborted.reject(signal.reason)
  signal.addEventListener("abort", onAbort, { once: true })
  let pending: Promise<[PromiseSettledResult<number>, PromiseSettledResult<number>]> | undefined
  let failure: { error: unknown } | undefined
  let ready: { attempts: number; A: number; AAAA: number; elapsedMs: number } | undefined
  async function query(family: 4 | 6) {
    try {
      const value = await (family === 4
        ? resolver.resolve4(url.hostname, { ttl: true })
        : resolver.resolve6(url.hostname, { ttl: true }))
      const length = field(value, "length")
      if (
        !Array.isArray(value) ||
        typeof length !== "number" ||
        !Number.isInteger(length) ||
        length < 0 ||
        length > 65535
      )
        throw new Error("Public DNS readiness returned invalid records")
      let count = 0
      for (let index = 0; index < length; index++) {
        const address = field(field(value, String(index)), "address")
        if (typeof address === "string" && isIP(address) === family) count++
      }
      return count
    } catch (error) {
      if (!dnsCodes.has(errorCode(error))) throw error
      return 0
    }
  }
  try {
    signal.throwIfAborted()
    for (let attempts = 1; ; attempts++) {
      pending = Promise.allSettled([query(4), query(6)])
      const [v4, v6] = await Promise.race([pending, aborted.promise])
      signal.throwIfAborted()
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
      await delay(250, undefined, { signal })
    }
  } catch (error) {
    failure = { error: signal.aborted ? signal.reason : error }
  } finally {
    signal.removeEventListener("abort", onAbort)
    try {
      resolver.cancel()
    } catch (error) {
      failure = {
        error: failure
          ? new AggregateError([failure.error, error], "Public DNS readiness and its owned cancellation failed")
          : error,
      }
    }
    await pending
  }
  if (failure) throw failure.error
  if (!ready) throw new Error("Public DNS readiness ended without a positive response")
  return ready
}
