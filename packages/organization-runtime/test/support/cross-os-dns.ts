import { Resolver } from "node:dns/promises"

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
