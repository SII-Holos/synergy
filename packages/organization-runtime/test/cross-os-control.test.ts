import { expect, test } from "bun:test"
import { readControlJSON } from "./support/cross-os-transport"

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
