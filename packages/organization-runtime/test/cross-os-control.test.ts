import { expect, test } from "bun:test"
import { readControlJSON, safeCrossOSFailure } from "./support/cross-os-transport"
import { observeDNSAfterFailedHealth } from "./support/cross-os-dns"

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
          { ttl: 12, address: "private-address" },
          {
            get ttl() {
              getters++
              return 99
            },
            address: "private-address",
          },
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
    A: { code: "OK", count: 3, ttlCount: 2, ttlMin: 12, ttlMax: 30 },
    AAAA: { code: "ENODATA", count: 0 },
  })
  expect(cancels).toBe(0)
  expect(getters).toBe(0)
  for (const privateValue of [origin, "synthetic-original", "private-address", "private-message", "headers"])
    expect(JSON.stringify(observed)).not.toContain(privateValue)
  const unavailable = await observeDNSAfterFailedHealth(origin, 1, () => {
    throw { code: "PRIVATE_ERROR_BODY", message: "private-constructor-error" }
  })
  expect(unavailable).toMatchObject({ available: false, code: "OTHER" })
  expect(JSON.stringify(unavailable)).not.toContain("PRIVATE_ERROR_BODY")
  expect(JSON.stringify(unavailable)).not.toContain("private-constructor-error")
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
