import { Resolver } from "node:dns/promises"
import { isIP } from "node:net"

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
function records(value: unknown, family: 4 | 6) {
  const count = field(value, "length")
  if (!Array.isArray(value) || typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > 65535)
    return { code: "INVALID_RESULT", count: 0 }
  let validAddressCount = 0,
    ttlCount = 0,
    ttlMin = Infinity,
    ttlMax = 0
  for (let index = 0; index < count; index++) {
    const record = field(value, String(index))
    const address = field(record, "address")
    if (typeof address === "string" && isIP(address) === family) validAddressCount++
    const ttl = field(record, "ttl")
    if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 0 || ttl > 4294967295) continue
    ttlCount++
    ttlMin = Math.min(ttlMin, ttl)
    ttlMax = Math.max(ttlMax, ttl)
  }
  return {
    code: "OK",
    count,
    validAddressCount,
    invalidAddressCount: count - validAddressCount,
    ttlCount,
    ...(ttlCount ? { ttlMin, ttlMax } : {}),
  }
}

function cancelResolver(resolver: FailedHealthResolver) {
  try {
    resolver.cancel()
  } catch (error) {
    return errorCode(error)
  }
}
async function resolverRecords(resolver: FailedHealthResolver, hostname: string, family: 4 | 6) {
  try {
    const value = await (family === 4
      ? resolver.resolve4(hostname, { ttl: true })
      : resolver.resolve6(hostname, { ttl: true }))
    return records(value, family)
  } catch (error) {
    return { code: errorCode(error), count: 0 }
  }
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
      cancelError = cancelResolver(resolver)
    },
    Math.max(0, 500 - (performance.now() - started)),
  )
  const deadlineTimer = setTimeout(() => deadline.resolve(), Math.max(0, 750 - (performance.now() - started)))
  async function query(family: "A" | "AAAA") {
    const queryStarted = performance.now()
    answers[family] = {
      ...(await resolverRecords(resolver, hostname, family === "A" ? 4 : 6)),
      elapsedMs: performance.now() - queryStarted,
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

type TemporaryNameReason =
  | "valid-address"
  | "invalid-name"
  | "constructor-error"
  | "cancel-error"
  | "no-valid-address"
  | "work-cutoff"
  | "observation-cutoff"
  | "original-abort"
  | "cleanup"
type TemporaryNameHint = {
  purpose: "temporary-name-observation-only"
  hint: boolean
  reason: TemporaryNameReason
  rounds: number
  elapsedMs: number
  queries: number
  queriesSettled: boolean
  cancelErrors: string[]
  A?: Awaited<ReturnType<typeof resolverRecords>>
  AAAA?: Awaited<ReturnType<typeof resolverRecords>>
}

// Provenance: https://blog.cloudflare.com/quick-tunnels-anytime-anywhere/
// https://github.com/c-ares/c-ares/blob/c7a3138dcfe3bb0eaaf10c0c24c36dc66dc790ab/src/lib/ares_qcache.c#L274-L343
// Fresh channels bound a new hostname publication hint; native HTTPS alone establishes readiness.
export function observeTemporaryName(
  hostname: string,
  signal: AbortSignal,
  createResolver: (options: { timeout: number; tries: number }) => FailedHealthResolver = (options) =>
    new Resolver(options),
) {
  const started = performance.now()
  const result = Promise.withResolvers<TemporaryNameHint>()
  const owners: Array<{ resolver: FailedHealthResolver; cancelled: boolean }> = []
  const pending: Array<{ promise: Promise<void>; settled(): boolean; dispatched(): boolean }> = []
  const answers: Pick<TemporaryNameHint, "A" | "AAAA"> = {}
  const cancelErrors: string[] = []
  let rounds = 0,
    finished = false,
    working = true
  let nextTimer: ReturnType<typeof setTimeout> | undefined
  let workTimer: ReturnType<typeof setTimeout> | undefined
  let windowTimer: ReturnType<typeof setTimeout> | undefined
  function cancel(owner: (typeof owners)[number]) {
    if (owner.cancelled) return
    owner.cancelled = true
    const error = cancelResolver(owner.resolver)
    if (error !== undefined) cancelErrors.push(error)
  }
  function finish(reason: TemporaryNameReason, hint = false) {
    if (finished) return
    finished = true
    if (nextTimer !== undefined) clearTimeout(nextTimer)
    if (workTimer !== undefined) clearTimeout(workTimer)
    if (windowTimer !== undefined) clearTimeout(windowTimer)
    signal.removeEventListener("abort", onAbort)
    for (const owner of owners) cancel(owner)
    result.resolve({
      purpose: "temporary-name-observation-only",
      hint,
      reason,
      rounds,
      elapsedMs: performance.now() - started,
      queries: pending.filter((entry) => entry.dispatched()).length,
      queriesSettled: pending.filter((entry) => entry.dispatched()).every((entry) => entry.settled()),
      cancelErrors: [...cancelErrors],
      ...(answers.A ? { A: { ...answers.A } } : {}),
      ...(answers.AAAA ? { AAAA: { ...answers.AAAA } } : {}),
    })
  }
  function onAbort() {
    finish("original-abort")
  }
  function round() {
    if (finished || !working || performance.now() - started >= 500) return
    rounds++
    let resolver: FailedHealthResolver
    try {
      resolver = createResolver({ timeout: 250, tries: 1 })
    } catch {
      finish("constructor-error")
      return
    }
    const owner = { resolver, cancelled: false }
    owners.push(owner)
    if (finished || signal.aborted || !working || performance.now() - started >= 500) {
      cancel(owner)
      if (!finished)
        finish(
          signal.aborted ? "original-abort" : performance.now() - started >= 750 ? "observation-cutoff" : "work-cutoff",
        )
      return
    }
    const pair = ([4, 6] as const).map((family) => {
      let settled = false,
        dispatched = false
      const promise = Promise.resolve().then(async () => {
        try {
          if (finished || signal.aborted || !working || performance.now() - started >= 500) {
            cancel(owner)
            if (!finished)
              finish(
                signal.aborted
                  ? "original-abort"
                  : performance.now() - started >= 750
                    ? "observation-cutoff"
                    : "work-cutoff",
              )
            return
          }
          dispatched = true
          const facts = await resolverRecords(resolver, hostname, family)
          if (finished) return
          answers[family === 4 ? "A" : "AAAA"] = facts
          if (performance.now() - started >= 750) {
            finish("observation-cutoff")
            return
          }
          if (signal.aborted) {
            finish("original-abort")
            return
          }
          if (
            "validAddressCount" in facts &&
            typeof facts.validAddressCount === "number" &&
            facts.validAddressCount > 0
          )
            finish("valid-address", true)
        } finally {
          settled = true
        }
      })
      pending.push({ promise, settled: () => settled, dispatched: () => dispatched })
      return promise
    })
    void Promise.allSettled(pair).then(() => {
      cancel(owner)
      if (finished) return
      if (cancelErrors.length) {
        finish("cancel-error")
        return
      }
      if (rounds >= 2 || !working || performance.now() - started >= 500) {
        finish("no-valid-address")
        return
      }
      nextTimer = setTimeout(round, Math.max(0, 250 - (performance.now() - started)))
    })
  }
  signal.addEventListener("abort", onAbort, { once: true })
  if (signal.aborted) finish("original-abort")
  else if (hostname.length > 253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(hostname)) finish("invalid-name")
  else {
    workTimer = setTimeout(
      () => {
        working = false
        for (const owner of owners) cancel(owner)
        if (pending.every((entry) => entry.settled())) finish("work-cutoff")
      },
      Math.max(0, 500 - (performance.now() - started)),
    )
    windowTimer = setTimeout(() => finish("observation-cutoff"), Math.max(0, 750 - (performance.now() - started)))
    round()
  }
  return {
    result: result.promise,
    async close() {
      finish("cleanup")
      for (const owner of owners) cancel(owner)
      const remaining = Math.max(0, 750 - (performance.now() - started))
      if (remaining > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            Promise.allSettled(pending.map((entry) => entry.promise)),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, remaining)
            }),
          ])
        } finally {
          if (timer !== undefined) clearTimeout(timer)
        }
      }
      const queriesSettled = pending.filter((entry) => entry.dispatched()).every((entry) => entry.settled())
      return {
        channels: owners.length,
        queries: pending.filter((entry) => entry.dispatched()).length,
        queriesSettled,
        settlement: queriesSettled ? ("complete" as const) : ("not-observed" as const),
        cancelErrors: [...cancelErrors],
      }
    },
  }
}
