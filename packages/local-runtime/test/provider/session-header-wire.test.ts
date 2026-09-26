import { describe, expect, test } from "bun:test"
import { generateText } from "ai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"

describe("x-opencode-session reaches the wire", () => {
  test("per-call headers flow through @ai-sdk/openai-compatible", async () => {
    const requests: string[] = []
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, data) {
          requests.push(new TextDecoder().decode(data))
          const body = JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion",
            created: 0,
            model: "test-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "OK" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
          socket.write(
            `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
          )
          socket.end()
        },
      },
    })
    try {
      const sdk = createOpenAICompatible({
        name: "opencode-go-test",
        baseURL: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "test-key",
      })
      await generateText({
        model: sdk.languageModel("test-model"),
        messages: [{ role: "user", content: [{ type: "text", text: "Reply with OK only." }] }],
        headers: { "x-opencode-session": "ses_wire" },
        maxOutputTokens: 8,
        abortSignal: AbortSignal.timeout(10_000),
      })
      expect(requests.join("\n")).toContain("x-opencode-session: ses_wire")
    } finally {
      server.stop(true)
    }
  })
})
