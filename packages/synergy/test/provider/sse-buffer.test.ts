import { describe, expect, test } from "bun:test"
import { ProviderStream } from "../../src/provider/stream"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function source(...chunks: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

async function read(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  let output = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) return output
    output += decoder.decode(value, { stream: true })
  }
}

describe("ProviderStream.limitSSEEventBytes", () => {
  test("passes bounded events and recognizes delimiters split across chunks", async () => {
    const input = ["data: first\r", "\n\r", "\ndata: second\n", "\n"]
    const output = await read(ProviderStream.limitSSEEventBytes(source(...input), 32))
    expect(output).toBe(input.join(""))
  })

  test("terminates an unterminated event at the byte limit", async () => {
    const stream = ProviderStream.limitSSEEventBytes(source("data: ", "x".repeat(33)), 32)
    await expect(read(stream)).rejects.toThrow("SSE event exceeded 32 bytes")
  })
})
