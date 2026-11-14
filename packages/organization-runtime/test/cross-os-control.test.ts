import { expect, test } from "bun:test"
import { readControlJSON, safeCrossOSFailure } from "./support/cross-os-transport"

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
