import { describe, expect, test } from "bun:test"
import { ProcessOutput } from "../../src/process/output"

function chunks(...values: string[]) {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const value of values) controller.enqueue(encoder.encode(value))
      controller.close()
    },
  })
}

describe("ProcessOutput.lines", () => {
  test("decodes chunked LF and CRLF records without retaining the full stream", async () => {
    const lines = await Array.fromAsync(ProcessOutput.lines(chunks("alpha\r", "\nbeta\npar", "tial")))
    expect(lines).toEqual(["alpha", "beta", "partial"])
  })

  test("rejects an oversized record before buffering the rest of the stream", async () => {
    const result = Array.fromAsync(
      ProcessOutput.lines(chunks("12345", "67890\nignored\n"), {
        maxRecordBytes: 8,
        maxOutputBytes: 1024,
      }),
    )
    await expect(result).rejects.toMatchObject({ reason: "max_record_bytes" })
  })

  test("yields complete records that precede an oversized record in the same chunk", async () => {
    const observed: string[] = []
    let failure: unknown
    try {
      for await (const line of ProcessOutput.lines(chunks("safe\n123456789\n"), { maxRecordBytes: 8 })) {
        observed.push(line)
      }
    } catch (error) {
      failure = error
    }

    expect(observed).toEqual(["safe"])
    expect(failure).toMatchObject({ reason: "max_record_bytes" })
  })

  test("enforces the cumulative byte limit while preserving complete earlier records", async () => {
    const observed: string[] = []
    let failure: unknown
    try {
      for await (const line of ProcessOutput.lines(chunks("one\ntwo\nthree\n"), { maxOutputBytes: 9 })) {
        observed.push(line)
      }
    } catch (error) {
      failure = error
    }

    expect(observed).toEqual(["one", "two"])
    expect(failure).toMatchObject({ reason: "max_output_bytes" })
  })

  test("accepts output that ends exactly at the cumulative byte limit", async () => {
    const lines = await Array.fromAsync(ProcessOutput.lines(chunks("one\ntwo\n"), { maxOutputBytes: 8 }))
    expect(lines).toEqual(["one", "two"])
  })

  test("does not yield complete records after abort is observed", async () => {
    const controller = new AbortController()
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      pull(streamController) {
        streamController.enqueue(encoder.encode("late\n"))
        controller.abort(new DOMException("Aborted", "AbortError"))
        streamController.close()
      },
    })
    const observed: string[] = []
    await expect(
      (async () => {
        for await (const line of ProcessOutput.lines(stream, { signal: controller.signal })) observed.push(line)
      })(),
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(observed).toEqual([])
  })
})

describe("ProcessOutput.drainText", () => {
  test("continues draining after the retained stderr limit", async () => {
    const result = await ProcessOutput.drainText(chunks("abcd", "efgh", "ijkl"), { maxBytes: 6 })
    expect(result).toEqual({ text: "abcdef", truncated: true })
  })
})
