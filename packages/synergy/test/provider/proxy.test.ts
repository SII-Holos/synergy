import { test, expect } from "bun:test"
import { generateText, streamText } from "ai"
import { Provider } from "../../src/provider/provider"

function makeModel(overrides: Partial<Provider.Model> = {}): Provider.Model {
  return {
    id: "test-model",
    providerID: "test-provider",
    api: {
      id: "test-model",
      url: "https://api.test.com/v1",
      npm: "@ai-sdk/openai",
    },
    name: "Test Model",
    capabilities: {
      interleaved: false,
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
    },
    cost: {
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    },
    limit: {
      context: 128000,
      output: 4096,
    },
    status: "active" as const,
    options: {},
    headers: {},
    release_date: "2024-01-01",
    ...overrides,
  }
}

function createProbeProxy(label: string) {
  let hits = 0
  const lines: string[] = []
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        hits++
        const line = new TextDecoder().decode(data).split("\r\n")[0] ?? ""
        lines.push(line)
        socket.write("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
        socket.end()
      },
    },
  })
  return {
    label,
    url: `http://127.0.0.1:${server.port}`,
    get hits() {
      return hits
    },
    get lines() {
      return lines
    },
    stop() {
      server.stop()
    },
  }
}

function createChunkedServer() {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket) {
        socket.write("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: text/plain\r\n\r\n")
        socket.write("6\r\nhello \r\n")
        socket.write("5\r\nworld\r\n")
        socket.write("0\r\n\r\n")
        socket.end()
      },
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop() {
      server.stop()
    },
  }
}

function createOpenAICompatibleServer() {
  let hits = 0
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        hits++
        const request = new TextDecoder().decode(data)
        const isStreaming = request.includes('"stream":true')
        const body = isStreaming
          ? [
              'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}',
              'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
              "data: [DONE]",
              "",
            ].join("\n\n")
          : JSON.stringify({
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
        const contentType = isStreaming ? "text/event-stream" : "application/json"
        socket.write(
          `HTTP/1.1 200 OK\r\nContent-Type: ${contentType}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        )
        socket.end()
      },
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    get hits() {
      return hits
    },
    stop() {
      server.stop()
    },
  }
}

function createOpenAIResponsesServer() {
  let hits = 0
  const lines: string[] = []
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        hits++
        lines.push(new TextDecoder().decode(data).split("\r\n")[0] ?? "")
        const body = JSON.stringify({
          id: "resp_test",
          object: "response",
          created_at: 0,
          status: "completed",
          model: "test-model",
          output: [
            {
              id: "msg_test",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "OK", annotations: [] }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        })
        socket.write(
          `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        )
        socket.end()
      },
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    get hits() {
      return hits
    },
    get lines() {
      return lines
    },
    stop() {
      server.stop()
    },
  }
}

async function tryFetch(patchedFetch: (input: any, init?: any) => Promise<Response>) {
  try {
    await patchedFetch("http://127.0.0.1:1/proxy-test", { signal: AbortSignal.timeout(1_000) })
  } catch {}
}

test("proxy option routes wrapped fetch through configured proxy", async () => {
  const configuredProxy = createProbeProxy("configured")
  try {
    const sdk = Provider.createSDKFromSpec(makeModel(), {
      options: { proxy: configuredProxy.url, apiKey: "test-key" },
    })

    await tryFetch((sdk as any).fetch)

    expect(configuredProxy.hits).toBe(1)
  } finally {
    configuredProxy.stop()
  }
})

test("noProxy takes precedence when proxy is also set", async () => {
  const configuredProxy = createProbeProxy("configured")
  try {
    const sdk = Provider.createSDKFromSpec(makeModel(), {
      options: { proxy: configuredProxy.url, noProxy: true, apiKey: "test-key" },
    })

    await tryFetch((sdk as any).fetch)

    expect(configuredProxy.hits).toBe(0)
  } finally {
    configuredProxy.stop()
  }
})

test("noProxy direct fetch decodes chunked responses", async () => {
  const server = createChunkedServer()
  try {
    const sdk = Provider.createSDKFromSpec(makeModel(), {
      options: { noProxy: true, apiKey: "test-key" },
    })

    const response = await (sdk as any).fetch(`${server.url}/stream`, { signal: AbortSignal.timeout(1_000) })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("hello world")
  } finally {
    server.stop()
  }
})

test("noProxy uses direct transport for generateText requests", async () => {
  const server = createOpenAICompatibleServer()
  try {
    const sdk = Provider.createSDKFromSpec(
      makeModel({
        api: {
          id: "test-model",
          url: `${server.url}/v1`,
          npm: "@ai-sdk/openai-compatible",
        },
      }),
      { options: { noProxy: true, apiKey: "test-key" } },
    )

    const result = await generateText({
      model: sdk.languageModel("test-model"),
      prompt: "ping",
      abortSignal: AbortSignal.timeout(1_000),
    })

    expect(result.text).toBe("OK")
    expect(server.hits).toBe(1)
  } finally {
    server.stop()
  }
})

test("noProxy takes precedence over explicit proxy for generateText requests", async () => {
  const configuredProxy = createProbeProxy("configured")
  const server = createOpenAICompatibleServer()
  try {
    const sdk = Provider.createSDKFromSpec(
      makeModel({
        api: {
          id: "test-model",
          url: `${server.url}/v1`,
          npm: "@ai-sdk/openai-compatible",
        },
      }),
      { options: { proxy: configuredProxy.url, noProxy: true, apiKey: "test-key" } },
    )

    const result = await generateText({
      model: sdk.languageModel("test-model"),
      prompt: "ping",
      abortSignal: AbortSignal.timeout(1_000),
    })

    expect(result.text).toBe("OK")
    expect(server.hits).toBe(1)
    expect(configuredProxy.hits).toBe(0)
  } finally {
    configuredProxy.stop()
    server.stop()
  }
})

test("noProxy takes precedence over explicit proxy for OpenAI responses requests", async () => {
  const configuredProxy = createProbeProxy("configured")
  const server = createOpenAIResponsesServer()
  try {
    const sdk = Provider.createSDKFromSpec(
      makeModel({
        api: {
          id: "test-model",
          url: `${server.url}/v1`,
          npm: "@ai-sdk/openai",
        },
      }),
      { options: { proxy: configuredProxy.url, noProxy: true, apiKey: "test-key" } },
    )

    const result = await generateText({
      model: (sdk as any).responses("test-model"),
      prompt: "ping",
      abortSignal: AbortSignal.timeout(1_000),
    })

    expect(result.text).toBe("OK")
    expect(server.hits).toBe(1)
    expect(server.lines[0]).toBe("POST /v1/responses HTTP/1.1")
    expect(configuredProxy.hits).toBe(0)
  } finally {
    configuredProxy.stop()
    server.stop()
  }
})

test("noProxy takes precedence over explicit proxy for streamText requests", async () => {
  const configuredProxy = createProbeProxy("configured")
  const server = createOpenAICompatibleServer()
  try {
    const sdk = Provider.createSDKFromSpec(
      makeModel({
        api: {
          id: "test-model",
          url: `${server.url}/v1`,
          npm: "@ai-sdk/openai-compatible",
        },
      }),
      { options: { proxy: configuredProxy.url, noProxy: true, apiKey: "test-key" } },
    )

    const result = streamText({
      model: sdk.languageModel("test-model"),
      prompt: "ping",
      abortSignal: AbortSignal.timeout(1_000),
    })

    expect(await result.text).toBe("OK")
    expect(server.hits).toBe(1)
    expect(configuredProxy.hits).toBe(0)
  } finally {
    configuredProxy.stop()
    server.stop()
  }
})

test("createSDKFromSpec returns unwrapped SDK when no proxy option is configured", () => {
  const sdk = Provider.createSDKFromSpec(makeModel(), {
    options: { apiKey: "test-key" },
  })

  expect(sdk).toBeDefined()
  expect((sdk as any).fetch).not.toBeTypeOf("function")
})

test('noProxy string "true" does not enable noProxy', () => {
  const sdk = Provider.createSDKFromSpec(makeModel(), {
    options: { noProxy: "true", apiKey: "test-key" },
  })

  expect((sdk as any).fetch).not.toBeTypeOf("function")
})
