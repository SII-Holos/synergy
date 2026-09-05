import { describe, expect, test } from "bun:test"
import { generateText } from "ai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { ProviderSessionHeader } from "../../src/provider/session-header"

describe("ProviderSessionHeader", () => {
  test("adds x-opencode-session for the opencode-go provider id", () => {
    expect(ProviderSessionHeader.headers({ providerID: "opencode-go", sessionID: "ses_abc" })).toEqual({
      "x-opencode-session": "ses_abc",
    })
  })

  test("adds x-opencode-session for custom providers pointing at the OpenCode Go endpoint", () => {
    expect(
      ProviderSessionHeader.headers({
        providerID: "my-opencode-proxy",
        baseURL: "https://opencode.ai/zen/go/v1",
        sessionID: "ses_abc",
      }),
    ).toEqual({ "x-opencode-session": "ses_abc" })
  })

  test("does not add the header for other providers", () => {
    expect(
      ProviderSessionHeader.headers({
        providerID: "openai",
        baseURL: "https://api.openai.com/v1",
        sessionID: "ses_abc",
      }),
    ).toEqual({})
  })

  test("does not add the header for the non-Go OpenCode Zen endpoint", () => {
    expect(
      ProviderSessionHeader.headers({
        providerID: "opencode",
        baseURL: "https://opencode.ai/zen/v1",
        sessionID: "ses_abc",
      }),
    ).toEqual({})
  })

  test("reuses the given session id verbatim", () => {
    const first = ProviderSessionHeader.headers({ providerID: "opencode-go", sessionID: "ses_abc" })
    const second = ProviderSessionHeader.headers({ providerID: "opencode-go", sessionID: "ses_abc" })
    expect(first["x-opencode-session"]).toBe("ses_abc")
    expect(second["x-opencode-session"]).toBe("ses_abc")
  })

  test("falls back to a fresh UUID per call without a session", () => {
    const first = ProviderSessionHeader.headers({ providerID: "opencode-go" })
    const second = ProviderSessionHeader.headers({ providerID: "opencode-go" })
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    expect(first["x-opencode-session"]).toMatch(uuid)
    expect(second["x-opencode-session"]).toMatch(uuid)
    expect(first["x-opencode-session"]).not.toBe(second["x-opencode-session"])
  })

  test("user-configured model headers win over the injected session header", () => {
    const merged = ProviderSessionHeader.forRequest({
      model: {
        providerID: "opencode-go",
        api: { id: "test-model", npm: "@ai-sdk/openai-compatible", url: "https://opencode.ai/zen/go/v1" },
        headers: { "x-opencode-session": "user-pinned", "X-Custom": "keep" },
      },
      sessionID: "ses_abc",
    })
    expect(merged).toEqual({ "x-opencode-session": "user-pinned", "X-Custom": "keep" })
  })

  test("injects the session id when the model has no pinned header", () => {
    const merged = ProviderSessionHeader.forRequest({
      model: {
        providerID: "opencode-go",
        api: { id: "test-model", npm: "@ai-sdk/openai-compatible", url: "https://opencode.ai/zen/go/v1" },
        headers: {},
      },
      sessionID: "ses_abc",
    })
    expect(merged).toEqual({ "x-opencode-session": "ses_abc" })
  })

  test("passes other providers through untouched", () => {
    const merged = ProviderSessionHeader.forRequest({
      model: {
        providerID: "openai",
        api: { id: "test-model", npm: "@ai-sdk/openai", url: "https://api.openai.com/v1" },
        headers: { Authorization: "x" },
      },
      sessionID: "ses_abc",
    })
    expect(merged).toEqual({ Authorization: "x" })
  })

  test("does not match lookalike hosts that embed the endpoint text", () => {
    expect(
      ProviderSessionHeader.headers({
        providerID: "my-opencode-proxy",
        baseURL: "https://notopencode.ai/zen/go/v1",
        sessionID: "ses_abc",
      }),
    ).toEqual({})
  })

  test("does not match endpoint text smuggled into another host's URL", () => {
    expect(
      ProviderSessionHeader.headers({
        providerID: "my-opencode-proxy",
        baseURL: "https://evil.example/v1?next=https://opencode.ai/zen/go",
        sessionID: "ses_abc",
      }),
    ).toEqual({})
  })

  test("checks the provider options baseURL override", () => {
    const merged = ProviderSessionHeader.forRequest({
      model: {
        providerID: "my-opencode",
        api: { id: "m", npm: "@ai-sdk/openai-compatible", url: "https://catalog.example/v1" },
        options: {},
        headers: {},
      },
      providerOptions: { baseURL: "https://opencode.ai/zen/go/v1" },
      sessionID: "ses_abc",
    })
    expect(merged).toEqual({ "x-opencode-session": "ses_abc" })
  })

  test("does not send the header when the endpoint is overridden away from OpenCode Go", () => {
    const merged = ProviderSessionHeader.forRequest({
      model: {
        providerID: "opencode-go",
        api: { id: "m", npm: "@ai-sdk/openai-compatible", url: "https://opencode.ai/zen/go/v1" },
        options: {},
        headers: {},
      },
      providerOptions: { baseURL: "https://my-proxy.example/v1" },
      sessionID: "ses_abc",
    })
    expect(merged).toEqual({})
  })

  test("model options baseURL wins over provider options when checking the endpoint", () => {
    const merged = ProviderSessionHeader.forRequest({
      model: {
        providerID: "my-opencode",
        api: { id: "m", npm: "@ai-sdk/openai-compatible", url: "https://catalog.example/v1" },
        options: { baseURL: "https://opencode.ai/zen/go/v1" },
        headers: {},
      },
      providerOptions: { baseURL: "https://other.example/v1" },
      sessionID: "ses_abc",
    })
    expect(merged).toEqual({ "x-opencode-session": "ses_abc" })
  })

  test("case-insensitive pinned session header replaces the generated one without duplication", () => {
    const merged = ProviderSessionHeader.forRequest({
      model: {
        providerID: "opencode-go",
        api: { id: "m", npm: "@ai-sdk/openai-compatible", url: "https://opencode.ai/zen/go/v1" },
        options: {},
        headers: { "X-OpenCode-Session": "pinned", "X-Custom": "keep" },
      },
      sessionID: "ses_abc",
    })
    expect(merged).toEqual({ "X-OpenCode-Session": "pinned", "X-Custom": "keep" })
  })
})

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
