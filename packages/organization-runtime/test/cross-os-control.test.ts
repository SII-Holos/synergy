import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import { z } from "zod"
import { cert, key } from "@ericsanchezok/synergy-testing/organization-tls"
import { testResources } from "@ericsanchezok/synergy-testing/resources"
import { createSocket } from "node:dgram"
import { execFileSync } from "node:child_process"
import { Resolver, getServers } from "node:dns/promises"
import { OrganizationProtocol } from "@ericsanchezok/synergy-organization-protocol"
import {
  safeCrossOSTransportText,
  safeCrossOSHeaderFailure,
  recordCrossOSHeaderFailure,
  isOriginalHeaderTimeout,
  type HeaderFailureSample,
  type HeaderFailureKindSample,
} from "./support/cross-os-failures"
import {
  readControlJSON,
  safeCrossOSFailure,
  readPublicPeerHealth,
  acceptPeerHealth,
  encode,
  PublicPeer,
  waitArtifact,
} from "./support/cross-os-transport"
import {
  observeDNSAfterFailedHealth,
  observeTemporaryName,
  observeDNSAfterFirstHeaderFailure,
} from "./support/cross-os-dns"
import {
  observeCrossOSFailureHTTP,
  observeCrossOSFailureChild,
  crossOSFailureBunScript,
  crossOSLibinfoFlag,
} from "./support/cross-os-post-failure-http"
import { summarizeCrossOSResolverRoute, observeCrossOSResolverRoute } from "./support/cross-os-resolver-route"
import { createCrossOSTunnelObservation, readCrossOSTunnelStderr } from "./support/cross-os-tunnel"

test("cross-OS JSON transport counts streamed bytes before decoding and cancels an oversized unsigned body", async () => {
  const expected = { label: "跨系统原始字节" }
  const encoded = Buffer.from(JSON.stringify(expected))
  let index = 0
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index === encoded.length) return controller.close()
        controller.enqueue(encoded.subarray(index, ++index))
      },
    }),
  )
  expect(await readControlJSON(response)).toEqual(expected)
  const exact = JSON.stringify({ value: "x".repeat(1024 * 1024 - 12) })
  expect(Buffer.byteLength(exact)).toBe(1024 * 1024)
  expect(await readControlJSON(new Response(exact))).toEqual(JSON.parse(exact))
  for (const declared of [undefined, "1"]) {
    const oversized = Buffer.from(JSON.stringify({ value: "x".repeat(2 * 1024 * 1024) }))
    let pulled = 0,
      offset = 0,
      cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === oversized.length) return controller.close()
        pulled++
        const end = Math.min(oversized.length, offset + 65536)
        controller.enqueue(oversized.subarray(offset, end))
        offset = end
      },
      cancel() {
        cancelled = true
      },
    })
    const request = new Request("https://synthetic.invalid/__cross-os-control", {
      method: "POST",
      body,
      headers: declared ? { "content-length": declared } : {},
    })
    const observed = await readControlJSON(request).then(
      () => ({ kind: "accepted" }),
      (error: unknown) => ({ kind: "refused", message: error instanceof Error ? error.message : "unknown" }),
    )
    expect(observed).toEqual({ kind: "refused", message: "Cross-OS control exceeded its bounded JSON body" })
    expect(cancelled).toBe(true)
    expect(pulled).toBeLessThanOrEqual(18)
    expect(request.body?.locked).toBe(false)
  }
  await expect(readControlJSON(new Response("invalid-json"))).rejects.toBeInstanceOf(SyntaxError)
})

test("cross-OS failure facts preserve canonical codes and original fixture frames without body, credentials or paths", () => {
  const secret = "private-body-and-credential"
  let getters = 0
  const failure = {
    name: "OrganizationError",
    data: { code: "COMMAND_OUTCOME_UNKNOWN", outcome: "unknown", message: secret },
    status: 504,
    stack: `Error: ${secret}\n at /private/runner/packages/organization-runtime/test/handoff-cross-os.test.ts:42:7\n at /private/runner/${secret}:1:2`,
    body: secret,
    headers: { authorization: secret },
  }
  Object.defineProperty(failure, "code", {
    get() {
      getters++
      return secret
    },
  })
  const observed = safeCrossOSFailure(failure)
  expect(observed).toEqual({
    name: "OrganizationError",
    thrownType: "object",
    code: "COMMAND_OUTCOME_UNKNOWN",
    outcome: "unknown",
    status: 504,
    frames: [{ file: "test/handoff-cross-os.test.ts", line: 42, column: 7 }],
  })
  expect(getters).toBe(0)
  expect(JSON.stringify(observed)).not.toContain(secret)
  expect(JSON.stringify(observed)).not.toContain("/private/runner")
  expect(safeCrossOSFailure(`<html>${secret}</html>`)).toEqual({
    name: "UnknownError",
    thrownType: "string",
    textLength: secret.length + 13,
  })
  expect(safeCrossOSFailure({ name: secret, code: "PRIVATE_BODY_AND_CREDENTIAL", outcome: secret })).toEqual({
    name: "UnknownError",
    thrownType: "object",
  })
  expect(
    safeCrossOSFailure({
      stack:
        "x".repeat(1_000_000) +
        "\n at /private/runner/packages/organization-runtime/test/handoff-cross-os.test.ts:42:7",
    }),
  ).toEqual({ name: "UnknownError", thrownType: "object" })
})

test("cross-OS failed-health DNS requires original ENOTFOUND and retains only counts, TTLs and finite codes", async () => {
  const origin = "https://synthetic-original.trycloudflare.com"
  let factories = 0,
    getters = 0,
    cancels = 0
  const calls: Array<{ family: string; hostname: string; ttl: boolean }> = []
  const factory = (options: { timeout: number; tries: number }) => {
    factories++
    expect(options).toEqual({ timeout: 250, tries: 1 })
    return {
      async resolve4(hostname: string, query: { ttl: true }) {
        calls.push({ family: "A", hostname, ttl: query.ttl })
        return [
          {
            ttl: 30,
            get address() {
              getters++
              return "private-address"
            },
          },
          { ttl: 12, address: "192.0.2.17" },
          {
            get ttl() {
              getters++
              return 99
            },
            address: "192.0.2.18",
          },
          { ttl: 30, address: "2001:db8::17" },
          { ttl: 30, address: "private-invalid-address" },
        ]
      },
      async resolve6(hostname: string, query: { ttl: true }): Promise<unknown> {
        calls.push({ family: "AAAA", hostname, ttl: query.ttl })
        throw {
          code: "ENODATA",
          get message() {
            getters++
            return "private-message"
          },
        }
      },
      cancel() {
        cancels++
      },
    }
  }
  expect(await observeDNSAfterFailedHealth(origin, 0, factory)).toBeUndefined()
  expect(factories).toBe(0)
  expect(await observeDNSAfterFailedHealth("https://unrelated.invalid", 1, factory)).toMatchObject({
    available: false,
    code: "INVALID_ORIGIN",
  })
  expect(factories).toBe(0)
  const observed = await observeDNSAfterFailedHealth(origin, 3, factory)
  expect(factories).toBe(1)
  expect(calls).toEqual([
    { family: "A", hostname: "synthetic-original.trycloudflare.com", ttl: true },
    { family: "AAAA", hostname: "synthetic-original.trycloudflare.com", ttl: true },
  ])
  expect(observed).toMatchObject({
    timing: "after-original-failure",
    sampling: "non-simultaneous",
    systemBaseline: { source: "original-public-health", code: "ENOTFOUND", count: 3 },
    available: true,
    cancelCalled: false,
    queriesSettled: true,
    A: { code: "OK", count: 5, validAddressCount: 2, invalidAddressCount: 3, ttlCount: 4, ttlMin: 12, ttlMax: 30 },
    AAAA: { code: "ENODATA", count: 0 },
  })
  expect(cancels).toBe(0)
  expect(getters).toBe(0)
  for (const privateValue of [
    origin,
    "synthetic-original",
    "private-address",
    "private-message",
    "headers",
    "192.0.2.17",
    "192.0.2.18",
    "2001:db8::17",
  ])
    expect(JSON.stringify(observed)).not.toContain(privateValue)
  const unavailable = await observeDNSAfterFailedHealth(origin, 1, () => {
    throw { code: "PRIVATE_ERROR_BODY", message: "private-constructor-error" }
  })
  expect(unavailable).toMatchObject({ available: false, code: "OTHER" })
  expect(JSON.stringify(unavailable)).not.toContain("PRIVATE_ERROR_BODY")
  expect(JSON.stringify(unavailable)).not.toContain("private-constructor-error")
  const families = await observeDNSAfterFailedHealth(origin, 1, () => ({
    async resolve4() {
      return [
        { address: "2001:db8::17", ttl: 20 },
        { address: "private-invalid-address", ttl: 30 },
      ]
    },
    async resolve6() {
      return [
        { address: "2001:db8::17", ttl: 8 },
        { address: "192.0.2.17", ttl: 60 },
      ]
    },
    cancel() {},
  }))
  expect(families).toMatchObject({
    A: { code: "OK", count: 2, validAddressCount: 0, invalidAddressCount: 2, ttlCount: 2, ttlMin: 20, ttlMax: 30 },
    AAAA: { code: "OK", count: 2, validAddressCount: 1, invalidAddressCount: 1, ttlCount: 2, ttlMin: 8, ttlMax: 60 },
  })
  for (const address of ["192.0.2.17", "2001:db8::17", "private-invalid-address"])
    expect(JSON.stringify(families)).not.toContain(address)
})

function wrappedDNSQuery(promise: Promise<unknown>) {
  return promise.then((value) => value).catch((error: unknown) => Promise.reject(error))
}

test("cross-OS failed-health DNS observes cancellation through the real promise wrapper depth", async () => {
  const A = Promise.withResolvers<unknown>(),
    AAAA = Promise.withResolvers<unknown>()
  let cancels = 0
  const observed = await observeDNSAfterFailedHealth("https://synthetic-held.trycloudflare.com", 1, () => ({
    resolve4: () => wrappedDNSQuery(A.promise),
    resolve6: () => wrappedDNSQuery(AAAA.promise),
    cancel() {
      cancels++
      A.reject({ code: "ECANCELLED", message: "private-A" })
      AAAA.reject({ code: "ECANCELLED", message: "private-AAAA" })
    },
  }))
  expect(observed).toMatchObject({
    available: true,
    cancelCalled: true,
    queriesSettled: true,
    A: { code: "ECANCELLED", count: 0 },
    AAAA: { code: "ECANCELLED", count: 0 },
  })
  expect(cancels).toBe(1)
  expect(JSON.stringify(observed)).not.toContain("private-")
}, 2000)

test("cross-OS failed-health DNS bounds a no-op cancellation without claiming a native leak", async () => {
  const A = Promise.withResolvers<unknown>(),
    AAAA = Promise.withResolvers<unknown>()
  const queries = [wrappedDNSQuery(A.promise), wrappedDNSQuery(AAAA.promise)]
  let cancels = 0
  const observed = await observeDNSAfterFailedHealth("https://synthetic-noop.trycloudflare.com", 1, () => ({
    resolve4: () => queries[0],
    resolve6: () => queries[1],
    cancel() {
      cancels++
    },
  }))
  expect(observed).toMatchObject({
    available: true,
    cancelCalled: true,
    queriesSettled: false,
    A: { code: "UNSETTLED", count: 0 },
    AAAA: { code: "UNSETTLED", count: 0 },
  })
  expect(cancels).toBe(1)
  const snapshot = JSON.stringify(observed)
  A.resolve([{ ttl: 12, address: "private-late-address" }])
  AAAA.reject({ code: "ENODATA", message: "private-late-error" })
  await Promise.allSettled(queries)
  expect(JSON.stringify(observed)).toBe(snapshot)
  expect(snapshot).not.toContain("private-")
})

test("cross-OS failed-health DNS reports cancellation failure without claiming settlement or invoking error getters", async () => {
  let getters = 0
  const pending = Promise.withResolvers<unknown>()
  const queries = [wrappedDNSQuery(pending.promise), wrappedDNSQuery(pending.promise)]
  const observed = await observeDNSAfterFailedHealth("https://synthetic-cancel.trycloudflare.com", 1, () => ({
    resolve4: () => queries[0],
    resolve6: () => queries[1],
    cancel() {
      throw {
        get code() {
          getters++
          return "ENOTFOUND"
        },
        message: "private-cancel-failure",
      }
    },
  }))
  expect(observed).toMatchObject({
    available: true,
    cancelCalled: true,
    cancelError: "OTHER",
    queriesSettled: false,
    A: { code: "UNSETTLED", count: 0 },
    AAAA: { code: "UNSETTLED", count: 0 },
  })
  expect(getters).toBe(0)
  const snapshot = JSON.stringify(observed)
  pending.reject({ code: "PRIVATE_ERROR_BODY", message: "private-late-error" })
  await Promise.allSettled(queries)
  expect(JSON.stringify(observed)).toBe(snapshot)
  expect(snapshot).not.toContain("private-")
})

test("cross-OS original header samples redact hostnames and retain only finite syscall, errno and hostname witnesses", () => {
  const hostname = "synthetic-original.trycloudflare.com"
  const other = "other.private.example"
  const failure = Object.assign(new TypeError("native header failure"), {
    code: "ECONNREFUSED",
    syscall: "connect",
    errno: -61,
    hostname,
    message: `connect ${hostname} [2001:db8::42]:443 192.0.2.31 https://${hostname}/private /home/runner/private-root/file authorization: Bearer private-credential`,
    cause: Object.assign(new Error("original resolver"), {
      code: "ENOTFOUND",
      syscall: "getaddrinfo",
      errno: "EAI_NONAME",
      hostname: other,
      message: `getaddrinfo ENOTFOUND ${other}`,
    }),
  })
  const observed = safeCrossOSHeaderFailure(failure, hostname)
  for (const value of [hostname, other, "2001:db8", "192.0.2.31", "https://", "private-root", "private-credential"])
    expect(JSON.stringify(observed)).not.toContain(value)
  expect(observed).toMatchObject({
    name: "TypeError",
    code: "ECONNREFUSED",
    syscall: "connect",
    errnoCategory: "negative-integer",
    hostnameMatches: true,
    cause: { code: "ENOTFOUND", syscall: "getaddrinfo", errnoCategory: "EAI_NONAME", hostnameMatches: false },
  })
  const nearBoundary = safeCrossOSTransportText("x".repeat(490) + " " + hostname + " tail")
  expect(nearBoundary).not.toContain("synthetic-original")
  expect(nearBoundary.length).toBeLessThanOrEqual(512)
  expect(safeCrossOSTransportText("bare " + hostname)).not.toContain(hostname)
  const collapsedBoundary = safeCrossOSTransportText("/home/runner/" + "x".repeat(2025) + " " + hostname + " tail")
  expect(collapsedBoundary).not.toContain("synthetic")
  expect(collapsedBoundary).not.toContain("runner/")
  expect(collapsedBoundary.length).toBeLessThanOrEqual(512)
  const expandedBoundary = safeCrossOSTransportText(
    "Bearer a ".repeat(4) + "/home/runner/" + "x".repeat(1953) + " " + hostname + " end",
  )
  expect(expandedBoundary).not.toContain("synthetic")
  expect(expandedBoundary).not.toContain("Bearer a")
  expect(expandedBoundary).not.toContain("runner/")
  expect(expandedBoundary.length).toBeLessThanOrEqual(512)
  const secret = "sk-abc_def.private.example"
  const secretHost = "def.private.example"
  const mixed = Object.assign(
    new Error(`standalone ${secret} Bearer ${secret} password=${secret} ${secretHost} /home/runner/${secret}`),
    { hostname: secretHost },
  )
  const mixedObserved = safeCrossOSHeaderFailure(mixed, hostname)
  for (const value of [secret, "sk-abc_", secretHost, "runner/"])
    expect(JSON.stringify(mixedObserved)).not.toContain(value)
  expect(mixedObserved.hostnameMatches).toBe(false)
  const unknown = safeCrossOSHeaderFailure(
    { name: "PRIVATE_NAME", code: "PRIVATE_CODE", syscall: "PRIVATE_SYSCALL", errno: "PRIVATE_ERRNO" },
    hostname,
  )
  expect(unknown).toEqual({ name: "UnknownError", syscall: "other", errnoCategory: "other-string" })
})

test("cross-OS original exception fields are observed without invoking accessors and causes remain bounded", async () => {
  let getters = 0
  const failure = new TypeError("native getter control")
  Object.defineProperty(failure, "stack", { value: "TypeError: native getter control" })
  for (const name of ["name", "code", "message", "syscall", "errno", "hostname", "cause", "address", "headers", "body"])
    Object.defineProperty(failure, name, {
      configurable: true,
      get() {
        getters++
        throw new Error("private accessor must not run")
      },
    })
  expect(safeCrossOSHeaderFailure(failure, "synthetic-original.trycloudflare.com")).toEqual({ name: "UnknownError" })
  expect(getters).toBe(0)
  const safe = safeCrossOSHeaderFailure(failure, "synthetic-original.trycloudflare.com")
  expect(isOriginalHeaderTimeout(failure, safe, [AbortSignal.abort(new Error("different owned reason"))])).toBe(false)
  expect(isOriginalHeaderTimeout(failure, safe, [AbortSignal.abort(failure)])).toBe(true)
  const inactive = new AbortController()
  expect(isOriginalHeaderTimeout(undefined, { name: "UnknownError" }, [inactive.signal, undefined])).toBe(false)
  const timeout = AbortSignal.timeout(1)
  await new Promise<void>((resolve) => {
    if (timeout.aborted) resolve()
    else timeout.addEventListener("abort", () => resolve(), { once: true })
  })
  const reason: unknown = timeout.reason
  expect(
    isOriginalHeaderTimeout(reason, safeCrossOSHeaderFailure(reason, "synthetic.trycloudflare.com"), [timeout]),
  ).toBe(true)
  expect(isOriginalHeaderTimeout(new Error("different failure"), { name: "Error" }, [timeout])).toBe(false)
  expect(getters).toBe(0)
  const deepest = Object.assign(new Error("deepest"), { cause: new Error("unretained private cause") })
  const nested = Object.assign(new Error("middle"), { cause: deepest })
  const observed = safeCrossOSHeaderFailure(
    Object.assign(new Error("outer"), { cause: nested }),
    "synthetic.trycloudflare.com",
  )
  expect(observed.cause?.cause?.name).toBe("Error")
  expect(observed.cause?.cause?.cause).toBeUndefined()
  expect(JSON.stringify(observed)).not.toContain("unretained private cause")
})

test("cross-OS first-kind samples survive exhausted first-four slots while original counters and finite limits remain", () => {
  const hostname = "synthetic-original.trycloudflare.com"
  type Cache = { available: false }
  const facts = {
    firstHeaderFailures: [] as HeaderFailureSample<Cache>[],
    firstFailureKinds: [] as HeaderFailureKindSample<Cache>[],
    failureKinds: {} as Record<string, number>,
  }
  let reads = 0
  function record(code: string, attempt: number, syscall = "getaddrinfo") {
    const failure = Object.assign(new TypeError("original failure for " + hostname), { code, syscall, hostname })
    recordCrossOSHeaderFailure(facts, safeCrossOSHeaderFailure(failure, hostname), () => {
      if (attempt <= 4) {
        expect(facts.failureKinds["TypeError:ENOTFOUND:no-cause:no-code"] ?? 0).toBe(attempt - 1)
        expect(facts.firstHeaderFailures).toHaveLength(attempt - 1)
      }
      reads++
      return {
        attempt,
        observedAtMs: 100 + attempt * 10,
        elapsedBeforeFailureMs: 2,
        fetchInvoked: true,
        dnsCache: { available: false },
      }
    })
  }
  for (let attempt = 1; attempt <= 4; attempt++) record("ENOTFOUND", attempt)
  record("ECONNREFUSED", 5, "connect")
  record("ECONNREFUSED", 6, "connect")
  expect(facts.firstHeaderFailures.map((sample) => sample.attempt)).toEqual([1, 2, 3, 4])
  expect(facts.firstFailureKinds.map((sample) => sample.attempt)).toEqual([1, 5])
  expect(facts.firstFailureKinds[1]).toMatchObject({
    observedAtMs: 150,
    failure: { code: "ECONNREFUSED", syscall: "connect", hostnameMatches: true },
  })
  expect(Object.values(facts.failureKinds)).toEqual([4, 2])
  expect(reads).toBe(5)
  for (const [index, code] of OrganizationProtocol.ErrorCode.options.entries()) record(code, index + 7)
  record("ENOTFOUND", 100)
  const counters = Object.keys(facts.failureKinds)
  expect(counters.slice(0, 2)).toEqual([
    "TypeError:ENOTFOUND:no-cause:no-code",
    "TypeError:ECONNREFUSED:no-cause:no-code",
  ])
  expect(facts.failureKinds[counters[0]]).toBe(5)
  expect(facts.firstFailureKinds).toHaveLength(16)
  expect(counters).toHaveLength(17)
  expect(facts.failureKinds.other).toBeGreaterThan(0)
  expect(facts.firstHeaderFailures).toHaveLength(4)
  expect(facts.firstFailureKinds[0].attempt).toBe(1)
  expect(reads).toBeLessThanOrEqual(20)
  expect(JSON.stringify(facts)).not.toContain(hostname)
})

test("original tunnel stderr records selection, EOF and actual child exit without changing readiness", async () => {
  const first = "https://synthetic-first.trycloudflare.com"
  const second = "https://synthetic-banner.trycloudflare.com"
  const observation = createCrossOSTunnelObservation()
  const firstLine = Promise.withResolvers<void>()
  const ready = Promise.withResolvers<string>()
  const readyOutcome = ready.promise.then(
    (origin) => ({ kind: "ready" as const, origin }),
    (error: unknown) => ({ kind: "failed" as const, error }),
  )
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `const input = Bun.stdin.stream().getReader();
       await Bun.write(Bun.stderr, ${JSON.stringify(first + "\n| https://synthetic-")});
       await input.read();
       await Bun.write(Bun.stderr, "banner.trycloudflare.com |\\nRegistered tunnel connection\\n");
       await input.read();
       input.releaseLock();`,
    ],
    { stdin: "pipe", stdout: "ignore", stderr: "pipe" },
  )
  observation.launched()
  const exited = child.exited.then((code) => observation.exited(code))
  const reader = readCrossOSTunnelStderr(child.stderr, {
    line(value) {
      observation.line(value)
      if (value === first) firstLine.resolve()
    },
    ready,
    selected: observation.selected,
    eof: observation.eof,
    settled: observation.settled,
  })
  try {
    await Promise.race([
      firstLine.promise,
      readyOutcome.then((outcome) => {
        if (outcome.kind === "failed") throw outcome.error
        throw new Error("The original child resolved readiness before its first line was observed")
      }),
    ])
    const partial = observation.snapshot()
    expect(partial.events.some((event) => event.kind === "selected")).toBe(true)
    expect(partial).not.toHaveProperty("selectedMatchesObservedBanner")
    expect(partial.events.some((event) => event.kind === "banner")).toBe(false)
    child.stdin.write("continue\n")
    await child.stdin.flush()
    const outcome = await readyOutcome
    if (outcome.kind === "failed") throw outcome.error
    expect(outcome.origin).toBe(first)
    const beforeCleanup = observation.snapshot()
    const retained = JSON.stringify(beforeCleanup)
    expect(beforeCleanup.selectedMatchesObservedBanner).toBe(false)
    expect(beforeCleanup.retainedDistinctHostnames).toBe(2)
    expect(beforeCleanup.events.some((event) => event.kind === "child-exit")).toBe(false)
    expect(beforeCleanup.events.some((event) => event.kind === "stderr-eof")).toBe(false)
    observation.cleanup("tunnel", "started")
    child.stdin.write("close\n")
    child.stdin.end()
    await exited
    await reader
    observation.cleanup("tunnel", "completed")
    const afterCleanup = observation.snapshot()
    expect(await child.exited).toBe(0)
    expect(afterCleanup.events.find((event) => event.kind === "child-exit")?.exitCode).toBe(0)
    expect(afterCleanup.events.some((event) => event.kind === "stderr-eof")).toBe(true)
    expect(afterCleanup.events.some((event) => event.kind === "reader-settled")).toBe(true)
    expect(afterCleanup.cleanupEvents.map(({ owner, phase }) => ({ owner, phase }))).toEqual([
      { owner: "tunnel", phase: "started" },
      { owner: "tunnel", phase: "completed" },
    ])
    expect(afterCleanup.events.every((event) => event.observedAtMs <= afterCleanup.observedAtMs)).toBe(true)
    expect(JSON.stringify(beforeCleanup)).toBe(retained)
    expect(JSON.stringify(afterCleanup)).not.toContain(first)
    expect(JSON.stringify(afterCleanup)).not.toContain(second)
  } finally {
    if (child.exitCode === null) child.kill()
    await exited
    await reader
  }
}, 30_000)

test("original tunnel EOF preserves failed readiness and bounds private hostname observations", async () => {
  const observation = createCrossOSTunnelObservation()
  const ready = Promise.withResolvers<string>()
  const readyOutcome = ready.promise.then(
    (origin) => ({ kind: "ready" as const, origin }),
    (error: unknown) => ({ kind: "failed" as const, error }),
  )
  const emitted = Array.from({ length: 12 }, (_, index) => `https://synthetic-${index}.trycloudflare.com`).join("\n")
  const child = Bun.spawn(
    [process.execPath, "--eval", `await Bun.write(Bun.stderr, ${JSON.stringify(emitted)}); process.exit(7);`],
    { stdout: "ignore", stderr: "pipe" },
  )
  observation.launched()
  const exited = child.exited.then((code) => observation.exited(code))
  const reader = readCrossOSTunnelStderr(child.stderr, {
    line: observation.line,
    ready,
    selected: observation.selected,
    eof: observation.eof,
    settled: observation.settled,
  })
  try {
    const outcome = await readyOutcome
    expect(outcome.kind).toBe("failed")
    if (outcome.kind === "ready") throw new Error("A URL without a registration must not become ready")
    expect(outcome.error).toBeInstanceOf(Error)
    expect((outcome.error as Error).message).toBe(
      "The task-owned tunnel exited before a public HTTPS endpoint was ready",
    )
    await exited
    await reader
    const result = observation.snapshot()
    expect(await child.exited).toBe(7)
    expect(result.retainedDistinctHostnames).toBe(4)
    expect(result.hostnameOverflow).toBe(true)
    expect(result).not.toHaveProperty("selectedMatchesObservedBanner")
    expect(result.events.some((event) => event.kind === "stderr-eof")).toBe(true)
    expect(result.events.some((event) => event.kind === "reader-settled")).toBe(true)
    expect(result.events.find((event) => event.kind === "child-exit")?.exitCode).toBe(7)
    expect(JSON.stringify(result)).not.toContain("trycloudflare")
  } finally {
    if (child.exitCode === null) child.kill()
    await exited
    await reader
  }
}, 30_000)

// Provenance: https://www.rfc-editor.org/rfc/rfc1035#section-4.1
// Local control: one task-owned DNS authority answers negatively without changing the HTTPS system resolver.
test("an independent raw DNS denial cannot determine the same host's actual HTTPS health and run identity", async () => {
  await using resources = testResources()
  const authority = createSocket("udp4")
  const failed = Promise.withResolvers<never>()
  void failed.promise.catch(() => {})
  const questions: Array<{ hostname: string; type: number }> = []
  authority.on("error", (error) => failed.reject(error))
  authority.on("message", (packet, peer) => {
    try {
      if (packet.length < 17 || packet.readUInt16BE(4) !== 1) throw new Error("Unexpected native DNS question")
      const labels: string[] = []
      let end = 12
      while (packet[end] !== 0) {
        const length = packet[end]
        if (length === undefined || length > 63 || end + length + 1 >= packet.length)
          throw new Error("Invalid native DNS name")
        labels.push(packet.subarray(end + 1, end + length + 1).toString("ascii"))
        end += length + 1
      }
      if (end + 5 > packet.length || packet.readUInt16BE(end + 3) !== 1) throw new Error("Invalid native DNS question")
      const type = packet.readUInt16BE(end + 1)
      if (type !== 1 && type !== 28) throw new Error("Unexpected native DNS record type")
      questions.push({ hostname: labels.join("."), type })
      const header = Buffer.alloc(12)
      packet.copy(header, 0, 0, 2)
      header.writeUInt16BE(0x8183, 2)
      header.writeUInt16BE(1, 4)
      authority.send(Buffer.concat([header, packet.subarray(12, end + 5)]), peer.port, peer.address, (error) => {
        if (error) failed.reject(error)
      })
    } catch (error) {
      failed.reject(error)
    }
  })
  await Promise.race([new Promise<void>((resolve) => authority.bind(0, "127.0.0.1", resolve)), failed.promise])
  resources.defer("independent DNS authority", () => new Promise<void>((resolve) => authority.close(() => resolve())))
  const defaults = JSON.stringify(getServers())
  const resolver = new Resolver({ timeout: 250, tries: 1 })
  let settled: Promise<PromiseSettledResult<unknown>[]> | undefined
  resources.defer("independent DNS query pair", async () => {
    resolver.cancel()
    await settled
  })
  resolver.setServers(["127.0.0.1:" + authority.address().port])
  const expected = { repository: "synthetic/acceptance", id: "1", attempt: "1", sha: "a".repeat(40) }
  let responseRun = expected
  let handled = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert, key },
    fetch(request) {
      assert.equal(new URL(request.url).hostname, "localhost")
      assert.equal(new URL(request.url).pathname, "/__cross-os-health")
      handled++
      return Response.json({ run: responseRun, native: "darwin" })
    },
  })
  resources.defer("original HTTPS health listener", () => server.stop(true))
  const origin = `https://localhost:${server.port}`
  const queries = [resolver.resolve4("localhost", { ttl: true }), resolver.resolve6("localhost", { ttl: true })]
  settled = Promise.allSettled(queries)
  async function readHealth(signal: AbortSignal) {
    signal.throwIfAborted()
    const response = await fetch(origin + "/__cross-os-health", { signal, tls: { ca: cert, rejectUnauthorized: true } })
    if (!response.ok) {
      await response.body?.cancel()
      return
    }
    const value = z.object({ run: z.unknown(), native: z.literal("darwin") }).parse(await response.json())
    assert.deepEqual(value.run, expected)
    return true
  }
  const negatives = await Promise.race([settled, failed.promise])
  for (const value of negatives) {
    expect(value.status).toBe("rejected")
    if (value.status !== "rejected") throw new Error("The raw authority did not deny the original name")
    expect(Object.getOwnPropertyDescriptor(value.reason, "code")?.value).toBe("ENOTFOUND")
  }
  expect(new Set(questions.map((question) => question.type))).toEqual(new Set([1, 28]))
  expect(questions.every((question) => question.hostname === "localhost")).toBe(true)
  let announcementFactories = 0
  const announcement = observeTemporaryName("localhost", new AbortController().signal, (options) => {
    announcementFactories++
    const selected = new Resolver(options)
    selected.setServers(["127.0.0.1:" + authority.address().port])
    return selected
  })
  resources.defer("original announcement query owners", () => announcement.close())
  const hint = await announcement.result
  expect(hint.hint).toBe(false)
  expect(announcementFactories).toBeGreaterThan(0)
  expect(announcementFactories).toBeLessThanOrEqual(2)
  expect(await readHealth(AbortSignal.timeout(5000))).toBe(true)
  expect(handled).toBe(1)
  responseRun = { ...expected, sha: "b".repeat(40) }
  const mismatch = await readHealth(AbortSignal.timeout(5000)).then(
    () => ({ status: "fulfilled" as const }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  )
  expect(mismatch.status).toBe("rejected")
  if (mismatch.status !== "rejected") throw new Error("The original health accepted another run")
  expect(mismatch.error).toBeInstanceOf(assert.AssertionError)
  expect(handled).toBe(2)
  const stopped = new AbortController()
  const reason = new Error("Original health bootstrap ended")
  stopped.abort(reason)
  const exhausted = await readHealth(stopped.signal).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(exhausted).toBe(reason)
  expect(handled).toBe(2)
  expect(JSON.stringify(getServers())).toBe(defaults)
}, 30_000)

test("post-failure HTTP observations validate the actual run/body and bound retained data", async () => {
  const run = { repository: "synthetic/repository", id: "1", attempt: "1", sha: "1".repeat(40) }
  expect(crossOSLibinfoFlag(undefined)).toBe("unset")
  for (const value of ["", "0", "false", "FaLsE", "NO", "Off"]) expect(crossOSLibinfoFlag(value)).toBe("falsy")
  for (const value of ["1", "true", " false ", "00", "false\n"]) expect(crossOSLibinfoFlag(value)).toBe("truthy")
  const input = { url: "https://synthetic.invalid/__cross-os-health", run, deadline: Date.now() + 1000 }
  const response = (body: unknown, status = 200) =>
    Object.assign(async () => Response.json(body, { status }), { preconnect() {} }) as typeof fetch
  const original = new Error("original-private-failure")
  const observed = await observeCrossOSFailureHTTP(input, response({ run, native: "darwin" }))
  expect(observed.code).toBe("OK")
  expect(observed.runMatches).toBe(true)
  expect(observed.nativeMatches).toBe(true)
  expect((await observeCrossOSFailureHTTP(input, response({ run: { ...run, id: "2" }, native: "darwin" }))).code).toBe(
    "WRONG_RUN",
  )
  expect((await observeCrossOSFailureHTTP(input, response({ run, native: "linux" }))).code).toBe("WRONG_NATIVE")
  expect((await observeCrossOSFailureHTTP(input, response({ run, native: "darwin" }, 503))).code).toBe("HTTP_STATUS")
  let cancelled = false
  const bounded = await observeCrossOSFailureHTTP(
    input,
    Object.assign(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(8193))
            },
            cancel() {
              cancelled = true
            },
          }),
        ),
      { preconnect() {} },
    ) as typeof fetch,
  )
  expect(bounded.code).toBe("BODY_LIMIT")
  expect(cancelled).toBe(true)
  let getters = 0
  const failure = Object.defineProperty({}, "code", {
    get() {
      getters++
      throw original
    },
  })
  const failed = await observeCrossOSFailureHTTP(
    input,
    Object.assign(
      async () => {
        throw failure
      },
      { preconnect() {} },
    ) as typeof fetch,
  )
  expect(failed.code).toBe("OTHER")
  const hostile = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw original
      },
      getOwnPropertyDescriptor() {
        throw original
      },
    },
  )
  const hostileFailure = await observeCrossOSFailureHTTP(
    input,
    Object.assign(
      async () => {
        throw hostile
      },
      { preconnect() {} },
    ) as typeof fetch,
  )
  expect(hostileFailure.code).toBe("OTHER")
  expect(getters).toBe(0)
  expect(JSON.stringify([observed, bounded, failed, hostileFailure])).not.toContain("synthetic.invalid")
  expect(JSON.stringify([observed, bounded, failed, hostileFailure])).not.toContain(original.message)
})

test("post-failure child observation drains real native pipes and never retains their secret text", async () => {
  const expected = { repository: "synthetic/repository", id: "1", attempt: "1", sha: "1".repeat(40) }
  const body = JSON.stringify({ run: expected, native: "darwin" })
  const inheritedFlag = process.env.BUN_FEATURE_FLAG_DISABLE_DNS_CACHE_LIBINFO
  const inheritedInput = process.env.SYNERGY_CROSS_OS_FAILURE_INPUT
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      crossOSFailureBunScript() + `; await Bun.write(Bun.stderr, "private-endpoint-and-token");`,
    ],
    {
      env: {
        ...process.env,
        BUN_FEATURE_FLAG_DISABLE_DNS_CACHE_LIBINFO: "0",
        SYNERGY_CROSS_OS_FAILURE_INPUT: JSON.stringify({
          url: "data:application/json," + encodeURIComponent(body),
          run: expected,
          deadline: Date.now() + 1500,
        }),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const owned = observeCrossOSFailureChild(child, "fresh-bun", expected)
  try {
    const observed = await owned.done
    expect(observed.code).toBe("OK")
    expect(observed.http?.bodyBytes).toBe(Buffer.byteLength(body))
    expect(observed.http?.runMatches).toBe(true)
    expect(observed.http?.nativeMatches).toBe(true)
    expect(observed.context?.libinfoFlag).toBe("falsy")
    expect(typeof observed.context?.pinnedBun).toBe("boolean")
    expect(observed.exited).toBe(true)
    expect(observed.exitCode).toBe(0)
    expect(observed.stdoutEOF).toBe(true)
    expect(observed.stderrEOF).toBe(true)
    expect(observed.stderrBytes).toBeGreaterThan(0)
    expect(JSON.stringify(observed)).not.toContain("private-endpoint-and-token")
  } finally {
    owned.cancel()
    await owned.done
  }
  const flaggedChild = Bun.spawn([process.execPath, "--eval", crossOSFailureBunScript()], {
    env: {
      ...process.env,
      SYNERGY_CROSS_OS_FAILURE_INPUT: JSON.stringify({
        url: "data:application/json," + encodeURIComponent(body),
        run: expected,
        deadline: Date.now() + 1500,
      }),
      BUN_FEATURE_FLAG_DISABLE_DNS_CACHE_LIBINFO: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const flagged = observeCrossOSFailureChild(flaggedChild, "fresh-bun", expected)
  try {
    const observed = await flagged.done
    expect(observed.code).toBe("OK")
    expect(observed.context?.libinfoFlag).toBe("truthy")
    expect(observed.http?.bodyBytes).toBe(Buffer.byteLength(body))
    expect(observed.exited && observed.stdoutEOF && observed.stderrEOF).toBe(true)
    expect(process.env.BUN_FEATURE_FLAG_DISABLE_DNS_CACHE_LIBINFO === inheritedFlag).toBe(true)
    expect(process.env.SYNERGY_CROSS_OS_FAILURE_INPUT === inheritedInput).toBe(true)
  } finally {
    flagged.cancel()
    await flagged.done
  }
  const oversized = Bun.spawn(
    [process.execPath, "--eval", `await Bun.write(Bun.stdout, "private-token".repeat(5000));`],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  const limited = observeCrossOSFailureChild(oversized, "fresh-bun", expected)
  try {
    const observed = await limited.done
    expect(observed.code).toBe("OUTPUT_LIMIT")
    expect(observed.outputLimit).toBe(true)
    expect(observed.stdoutEOF).toBe(true)
    expect(observed.stderrEOF).toBe(true)
    expect(observed.exited).toBe(true)
    expect(JSON.stringify(observed)).not.toContain("private-token")
  } finally {
    limited.cancel()
    await limited.done
  }
})

test("post-failure cancellation joins only its real owned child", async () => {
  const expected = { repository: "synthetic/repository", id: "1", attempt: "1", sha: "1".repeat(40) }
  const child = Bun.spawn([process.execPath, "--eval", `await Bun.stdin.text();`], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const owned = observeCrossOSFailureChild(child, "fresh-bun", expected)
  try {
    owned.cancel()
    const observed = await owned.done
    expect(observed.killCalled).toBe(true)
    expect(observed.killFailed).toBe(false)
    expect(observed.exited).toBe(true)
    expect(observed.stdoutEOF).toBe(true)
    expect(observed.stderrEOF).toBe(true)
  } finally {
    owned.cancel()
    await owned.done
    try {
      child.stdin.end()
    } catch {}
  }
})

test("temporary-name hints cannot veto HTTPS on constructor or cancellation errors and preserve original abort", async () => {
  const signal = new AbortController()
  const broken = observeTemporaryName("synthetic.test", signal.signal, () => {
    throw { code: "private-factory-error" }
  })
  const constructor = await broken.result
  expect(constructor).toMatchObject({ hint: false, reason: "constructor-error", queries: 0 })
  expect(JSON.stringify(constructor)).not.toContain("private-")
  await broken.close()
  const A = Promise.withResolvers<unknown>(),
    AAAA = Promise.withResolvers<unknown>()
  const failingCancel = observeTemporaryName("synthetic.test", signal.signal, () => ({
    resolve4: () => A.promise,
    resolve6: () => AAAA.promise,
    cancel() {
      throw { code: "private-cancel-error" }
    },
  }))
  A.resolve([{ address: "192.0.2.17", ttl: 20 }])
  const positive = await failingCancel.result
  expect(positive).toMatchObject({ hint: true, reason: "valid-address", cancelErrors: ["OTHER"] })
  AAAA.resolve([])
  expect((await failingCancel.close()).queriesSettled).toBe(true)
  const aborted = new AbortController(),
    reason = new Error("original-bootstrap-ended")
  const held = Promise.withResolvers<unknown>()
  void held.promise.catch(() => {})
  const original = observeTemporaryName("synthetic.test", aborted.signal, () => ({
    resolve4: () => held.promise,
    resolve6: () => held.promise,
    cancel() {
      held.reject(reason)
    },
  }))
  aborted.abort(reason)
  expect(await original.result).toMatchObject({ hint: false, reason: "original-abort" })
  expect(aborted.signal.reason).toBe(reason)
  await original.close()
})

test("temporary-name no-op cancellation cuts off and an expired positive cannot change its returned hint", async () => {
  const A = Promise.withResolvers<unknown>(),
    AAAA = Promise.withResolvers<unknown>()
  let cancels = 0
  const original = observeTemporaryName("synthetic.test", new AbortController().signal, () => ({
    resolve4: () => A.promise,
    resolve6: () => AAAA.promise,
    cancel() {
      cancels++
    },
  }))
  const hint = await original.result
  expect(hint).toMatchObject({ hint: false, reason: "observation-cutoff", queriesSettled: false })
  expect(cancels).toBe(1)
  const immutable = JSON.stringify(hint)
  expect(await original.close()).toMatchObject({ queriesSettled: false, settlement: "not-observed" })
  A.resolve([{ address: "192.0.2.17", ttl: 20 }])
  AAAA.resolve([])
  await Promise.allSettled([A.promise, AAAA.promise])
  expect(JSON.stringify(hint)).toBe(immutable)
  expect(hint.hint).toBe(false)
}, 2000)

test("temporary-name observation cancels constructor-abort owners and never dispatches a sibling after synchronous abort", async () => {
  const before = new AbortController(),
    beforeReason = new Error("original-constructor-abort")
  const beforeCalls: number[] = []
  let beforeCancels = 0
  const constructor = observeTemporaryName("synthetic.test", before.signal, () => {
    before.abort(beforeReason)
    return {
      async resolve4() {
        beforeCalls.push(4)
        return []
      },
      async resolve6() {
        beforeCalls.push(6)
        return []
      },
      cancel() {
        beforeCancels++
      },
    }
  })
  const constructorHint = await constructor.result
  await constructor.close()
  const during = new AbortController(),
    duringReason = new Error("original-first-family-abort")
  const duringCalls: number[] = []
  let duringCancels = 0
  const firstFamily = observeTemporaryName("synthetic.test", during.signal, () => ({
    async resolve4() {
      duringCalls.push(4)
      during.abort(duringReason)
      return []
    },
    async resolve6() {
      duringCalls.push(6)
      return []
    },
    cancel() {
      duringCancels++
    },
  }))
  const dispatchHint = await firstFamily.result
  await firstFamily.close()
  expect({
    constructor: {
      calls: beforeCalls,
      queries: constructorHint.queries,
      reason: constructorHint.reason,
      cancels: beforeCancels,
    },
    firstFamily: {
      calls: duringCalls,
      queries: dispatchHint.queries,
      reason: dispatchHint.reason,
      cancels: duringCancels,
    },
  }).toEqual({
    constructor: { calls: [], queries: 0, reason: "original-abort", cancels: 1 },
    firstFamily: { calls: [4], queries: 1, reason: "original-abort", cancels: 1 },
  })
  expect(before.signal.reason).toBe(beforeReason)
  expect(during.signal.reason).toBe(duringReason)
})

test("first native-failure DNS observations are labeled as overlapping original retries and retain no address values", async () => {
  const A = Promise.withResolvers<unknown>(),
    AAAA = Promise.withResolvers<unknown>()
  const calls: number[] = []
  const signal = new AbortController()
  const trigger = { attempt: 7, observedAtMs: performance.now() }
  const originalTrigger = { ...trigger }
  const sample = observeDNSAfterFirstHeaderFailure(
    "https://synthetic.trycloudflare.com",
    trigger,
    signal.signal,
    () => ({
      resolve4() {
        calls.push(4)
        return A.promise
      },
      resolve6() {
        calls.push(6)
        return AAAA.promise
      },
      cancel() {},
    }),
  )
  trigger.attempt = 99
  trigger.observedAtMs = -1
  A.resolve([{ address: "192.0.2.17", ttl: 377 }])
  AAAA.resolve([
    { address: "2001:db8::17", ttl: 377 },
    { address: "192.0.2.18", ttl: 377 },
  ])
  const observed = await sample.result
  expect(observed).toMatchObject({
    timing: "after-first-original-fetch-enotfound",
    sampling: "overlaps-original-retries",
    triggerAttempt: 7,
    originalFailureObservedAtMs: originalTrigger.observedAtMs,
    A: { code: "OK", validAddressCount: 1, invalidAddressCount: 0 },
    AAAA: { code: "OK", validAddressCount: 1, invalidAddressCount: 1 },
  })
  expect(observed.startedAtMs).toBeGreaterThanOrEqual(originalTrigger.observedAtMs)
  expect(observed.endedAtMs).toBeGreaterThanOrEqual(observed.startedAtMs)
  expect(calls).toEqual([4, 6])
  expect("systemBaseline" in observed).toBe(false)
  expect(JSON.stringify(observed)).not.toContain("192.0.2.")
  expect(JSON.stringify(observed)).not.toContain("2001:db8")
  expect(await sample.close()).toEqual({ resultObserved: true, queriesSettled: true, settlement: "complete" })
})

test("first-failure channels cancel on the original signal without dispatching an aborted sibling or restarting their close budget", async () => {
  const signal = new AbortController(),
    reason = new Error("original-budget-abort")
  const calls: number[] = []
  let cancels = 0
  const sample = observeDNSAfterFirstHeaderFailure(
    "https://synthetic.trycloudflare.com",
    { attempt: 1, observedAtMs: performance.now() },
    signal.signal,
    () => ({
      async resolve4() {
        calls.push(4)
        signal.abort(reason)
        return []
      },
      async resolve6() {
        calls.push(6)
        return []
      },
      cancel() {
        cancels++
      },
    }),
  )
  const observed = await sample.result
  expect(observed.abortObserved).toBe(true)
  expect(signal.signal.reason).toBe(reason)
  expect(calls).toEqual([4])
  expect(cancels).toBe(1)
  await sample.close()
  const failedCancel = observeDNSAfterFirstHeaderFailure(
    "https://synthetic.trycloudflare.com",
    { attempt: 1, observedAtMs: performance.now() },
    new AbortController().signal,
    () => ({
      async resolve4() {
        return []
      },
      async resolve6() {
        return []
      },
      cancel() {
        throw { code: "private-cancel-error" }
      },
    }),
  )
  await failedCancel.result
  expect(await failedCancel.close()).toMatchObject({ queriesSettled: true, cancelError: "OTHER" })
  const held = Promise.withResolvers<unknown>()
  const pending = observeDNSAfterFirstHeaderFailure(
    "https://synthetic.trycloudflare.com",
    { attempt: 1, observedAtMs: performance.now() },
    new AbortController().signal,
    () => ({
      resolve4: () => held.promise,
      resolve6: () => held.promise,
      cancel() {},
    }),
  )
  const bounded = await pending.result
  const original = JSON.stringify(bounded)
  expect(bounded).toMatchObject({ queriesSettled: false })
  expect(await pending.close()).toEqual({ resultObserved: true, queriesSettled: false, settlement: "not-observed" })
  held.resolve([])
  await held.promise
  expect(JSON.stringify(bounded)).toBe(original)
}, 2000)

const resolverConfiguration = `DNS configuration
resolver #1
  nameserver[0] : 192.0.2.1
  flags : Request A records
  reach : 0x00000002 (Reachable)
resolver #2
  domain : private.example
  nameserver[0] : 198.51.100.2
  order : 101000
DNS configuration (for scoped queries)
resolver #1
  nameserver[0] : 203.0.113.3
  if_index : 4 (private-interface)
  flags : Scoped
DNS configuration (for service-specific queries)
resolver #1
  nameserver[0] : 203.0.113.4
  service_identifier : 5
`

test("passive resolver summaries distinguish scoped servers from defaults without retaining domains or addresses", () => {
  const summary = summarizeCrossOSResolverRoute(resolverConfiguration, ["192.0.2.1"], "tunnel.private.example")
  expect(summary).toMatchObject({
    parseComplete: true,
    comparisonAvailable: true,
    generalResolverCount: 2,
    supplementalResolverCount: 1,
    scopedResolverCount: 1,
    serviceSpecificResolverCount: 1,
    firstGeneralServerSetEqual: true,
    domainlessGeneralServerSetEqual: true,
    matchingSupplementalDomainPresent: true,
  })
  expect(summarizeCrossOSResolverRoute(resolverConfiguration, ["203.0.113.3"], "xprivate.example")).toMatchObject({
    firstGeneralServerSetEqual: false,
    domainlessGeneralServerSetEqual: false,
    matchingSupplementalDomainPresent: false,
  })
  for (const secret of ["192.0.2.", "198.51.", "203.0.113.", "private.example", "private-interface"])
    expect(JSON.stringify(summary)).not.toContain(secret)
  for (const text of [
    resolverConfiguration + "unknown private field : secret\n",
    "x".repeat(65537),
    "No DNS configuration available\n" + resolverConfiguration,
  ]) {
    const incomplete = summarizeCrossOSResolverRoute(text, ["192.0.2.1"], "private.example")
    expect(incomplete).toMatchObject({
      parseComplete: false,
      comparisonAvailable: false,
      resolverCount: null,
      firstGeneralServerSetEqual: null,
      scopedPresent: null,
    })
  }
  expect(summarizeCrossOSResolverRoute(resolverConfiguration, undefined, "private.example").comparisonAvailable).toBe(
    false,
  )
  const scopedAddress = "DNS configuration\nresolver #1\n  nameserver[0] : fe80::1%private-interface\n"
  expect(summarizeCrossOSResolverRoute(scopedAddress, ["192.0.2.1"], "private.example")).toMatchObject({
    parseComplete: true,
    comparisonAvailable: false,
    firstGeneralServerSetEqual: null,
  })
  const scopedOnly = "DNS configuration (for scoped queries)\nresolver #1\n  nameserver[0] : 192.0.2.1\n"
  expect(
    summarizeCrossOSResolverRoute(scopedOnly, ["192.0.2.1"], "private.example").firstGeneralServerSetEqual,
  ).toBeNull()
})

test("post-cleanup configuration observation parses a real bounded child and contains unavailable or hostile observations", () => {
  const observed = observeCrossOSResolverRoute(
    "tunnel.private.example",
    () =>
      execFileSync(process.execPath, ["--eval", `process.stdout.write(${JSON.stringify(resolverConfiguration)})`], {
        timeout: 500,
        killSignal: "SIGKILL",
        maxBuffer: 65536,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      }),
    () => ({ getServers: () => ["192.0.2.1"] }),
  )
  expect(observed).toMatchObject({
    purpose: "post-cleanup-passive-configuration-only",
    channelAvailable: true,
    parseComplete: true,
    firstGeneralServerSetEqual: true,
  })
  expect(observed.endedAtMs).toBeGreaterThanOrEqual(observed.channelObservedAtMs)
  let getterCalls = 0
  const hostile = Object.defineProperty({}, "code", {
    get() {
      getterCalls++
      throw new Error("private-error")
    },
  })
  for (const error of [
    hostile,
    new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("private-proxy")
        },
      },
    ),
  ]) {
    const result = observeCrossOSResolverRoute(
      "private.example",
      () => {
        throw error
      },
      () => ({ getServers: () => [] }),
    )
    expect(result).toMatchObject({ parseComplete: false, comparisonAvailable: false, code: "OTHER" })
    expect(JSON.stringify(result)).not.toContain("private-")
  }
  expect(getterCalls).toBe(0)
  const missing = observeCrossOSResolverRoute(
    "private.example",
    () => resolverConfiguration,
    () => {
      throw new Error("private-config")
    },
  )
  expect(missing).toMatchObject({
    channelAvailable: false,
    comparisonAvailable: false,
    firstGeneralServerSetEqual: null,
  })
})

test("the original Linux peer verifies real strict HTTPS identity before its fixed health receipt", async () => {
  await using resources = testResources()
  const expected = { repository: "synthetic/acceptance", id: "1", attempt: "1", sha: "a".repeat(40) }
  let responseRun = expected,
    native = "darwin",
    handled = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert, key },
    fetch(request) {
      assert.equal(new URL(request.url).hostname, "localhost")
      assert.equal(new URL(request.url).pathname, "/__cross-os-health")
      handled++
      return Response.json({ run: responseRun, native })
    },
  })
  resources.defer("original peer HTTPS preparation listener", () => server.stop(true))
  const origin = `https://localhost:${server.port}`
  const request = (url: string, options: { signal: AbortSignal }) =>
    fetch(url, {
      ...options,
      tls: { ca: cert, rejectUnauthorized: true },
    })
  await readPublicPeerHealth(origin, expected, AbortSignal.timeout(5000), request)
  expect(handled).toBe(1)
  responseRun = { ...expected, sha: "b".repeat(40) }
  const wrongRun = await readPublicPeerHealth(origin, expected, AbortSignal.timeout(5000), request).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(wrongRun).toBeInstanceOf(Error)
  expect(handled).toBe(2)
  responseRun = expected
  native = "linux"
  const wrongNative = await readPublicPeerHealth(origin, expected, AbortSignal.timeout(5000), request).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(wrongNative).toBeInstanceOf(z.ZodError)
  expect(handled).toBe(3)
  native = "darwin"
  await readPublicPeerHealth(origin, expected, AbortSignal.timeout(5000), request)
  expect(handled).toBe(4)
  const stopped = new AbortController(),
    reason = new Error("Original bootstrap deadline")
  stopped.abort(reason)
  expect(await readPublicPeerHealth(origin, expected, stopped.signal, request).catch((error: unknown) => error)).toBe(
    reason,
  )
  expect(handled).toBe(4)
  expect(await waitArtifact("darwin", "origin", stopped.signal).catch((error: unknown) => error)).toBe(reason)
}, 15000)

test("the fixed peer health receipt is sealed, signed and bound to its original endpoint, stage and run", () => {
  const run = { repository: "synthetic/acceptance", id: "1", attempt: "1", sha: "a".repeat(40) }
  function peer(role: "darwin" | "linux") {
    const signing = generateKeyPairSync("ed25519"),
      encryption = generateKeyPairSync("x25519")
    return {
      public: PublicPeer.parse({
        version: 1,
        run,
        role,
        signing: signing.publicKey.export({ type: "spki", format: "pem" }).toString(),
        encryption: encryption.publicKey.export({ type: "spki", format: "pem" }).toString(),
      }),
      signing: signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      encryption: encryption.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    }
  }
  const darwin = peer("darwin"),
    linux = peer("linux"),
    foreign = peer("linux")
  const origin = "https://synthetic.trycloudflare.com"
  const receipt = encode(linux, darwin.public, "health", { origin, native: "darwin" })
  const nonces = new Set<string>()
  acceptPeerHealth(darwin, linux.public, origin, receipt, nonces)
  expect(nonces.size).toBe(1)
  expect(() => acceptPeerHealth(darwin, linux.public, origin, receipt, nonces)).toThrow("replay")
  expect(() => acceptPeerHealth(darwin, foreign.public, origin, receipt, new Set())).toThrow("signature")
  expect(() => acceptPeerHealth(darwin, linux.public, "https://another.trycloudflare.com", receipt, new Set())).toThrow(
    "endpoint or stage",
  )
  expect(() =>
    acceptPeerHealth(
      darwin,
      linux.public,
      origin,
      encode(linux, darwin.public, "ready", { origin, native: "darwin" }),
      new Set(),
    ),
  ).toThrow("endpoint or stage")
  expect(() =>
    acceptPeerHealth(
      darwin,
      linux.public,
      origin,
      encode(linux, darwin.public, "health", { origin, native: "linux" }),
      new Set(),
    ),
  ).toThrow()
  expect(() =>
    acceptPeerHealth(darwin, { ...linux.public, run: { ...run, attempt: "2" } }, origin, receipt, new Set()),
  ).toThrow("another run or head")
  acceptPeerHealth(
    darwin,
    linux.public,
    origin,
    encode(linux, darwin.public, "health", { origin, native: "darwin" }),
    new Set(),
  )
})
