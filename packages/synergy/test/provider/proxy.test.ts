import { test, expect } from "bun:test"
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

const proxyEnvKeys = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"] as const

function snapshotProxyEnv() {
  return Object.fromEntries(proxyEnvKeys.map((key) => [key, process.env[key]])) as Record<string, string | undefined>
}

function restoreProxyEnv(snapshot: Record<string, string | undefined>) {
  for (const key of proxyEnvKeys) {
    const value = snapshot[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
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

async function tryFetch(patchedFetch: (input: any, init?: any) => Promise<Response>) {
  try {
    await patchedFetch("http://127.0.0.1:1/proxy-test", { signal: AbortSignal.timeout(1_000) })
  } catch {}
}

test("noProxy bypasses system proxy env and restores it afterward", async () => {
  const snapshot = snapshotProxyEnv()
  const envProxy = createProbeProxy("env")
  try {
    process.env.HTTP_PROXY = envProxy.url
    process.env.HTTPS_PROXY = envProxy.url
    process.env.http_proxy = envProxy.url
    process.env.https_proxy = envProxy.url
    process.env.ALL_PROXY = envProxy.url
    process.env.all_proxy = envProxy.url

    const sdk = Provider.createSDKFromSpec(makeModel(), {
      options: { noProxy: true, apiKey: "test-key" },
    })

    await tryFetch((sdk as any).fetch)

    expect(envProxy.hits).toBe(0)
    expect(process.env.HTTP_PROXY).toBe(envProxy.url)
    expect(process.env.HTTPS_PROXY).toBe(envProxy.url)
    expect(process.env.http_proxy).toBe(envProxy.url)
    expect(process.env.https_proxy).toBe(envProxy.url)
    expect(process.env.ALL_PROXY).toBe(envProxy.url)
    expect(process.env.all_proxy).toBe(envProxy.url)
  } finally {
    envProxy.stop()
    restoreProxyEnv(snapshot)
  }
})

test("proxy option overrides system proxy env for the wrapped fetch", async () => {
  const snapshot = snapshotProxyEnv()
  const envProxy = createProbeProxy("env")
  const configuredProxy = createProbeProxy("configured")
  try {
    process.env.HTTP_PROXY = envProxy.url
    process.env.HTTPS_PROXY = envProxy.url
    process.env.http_proxy = envProxy.url
    process.env.https_proxy = envProxy.url

    const sdk = Provider.createSDKFromSpec(makeModel(), {
      options: { proxy: configuredProxy.url, apiKey: "test-key" },
    })

    await tryFetch((sdk as any).fetch)

    expect(envProxy.hits).toBe(0)
    expect(configuredProxy.hits).toBe(1)
    expect(process.env.HTTP_PROXY).toBe(envProxy.url)
    expect(process.env.HTTPS_PROXY).toBe(envProxy.url)
    expect(process.env.http_proxy).toBe(envProxy.url)
    expect(process.env.https_proxy).toBe(envProxy.url)
  } finally {
    envProxy.stop()
    configuredProxy.stop()
    restoreProxyEnv(snapshot)
  }
})

test("noProxy takes precedence when proxy is also set", async () => {
  const snapshot = snapshotProxyEnv()
  const envProxy = createProbeProxy("env")
  const configuredProxy = createProbeProxy("configured")
  try {
    process.env.HTTP_PROXY = envProxy.url
    process.env.HTTPS_PROXY = envProxy.url

    const sdk = Provider.createSDKFromSpec(makeModel(), {
      options: { proxy: configuredProxy.url, noProxy: true, apiKey: "test-key" },
    })

    await tryFetch((sdk as any).fetch)

    expect(envProxy.hits).toBe(0)
    expect(configuredProxy.hits).toBe(0)
  } finally {
    envProxy.stop()
    configuredProxy.stop()
    restoreProxyEnv(snapshot)
  }
})

test("noProxy direct fetch decodes chunked responses", async () => {
  const snapshot = snapshotProxyEnv()
  const envProxy = createProbeProxy("env")
  const server = createChunkedServer()
  try {
    process.env.HTTP_PROXY = envProxy.url
    process.env.HTTPS_PROXY = envProxy.url

    const sdk = Provider.createSDKFromSpec(makeModel(), {
      options: { noProxy: true, apiKey: "test-key" },
    })

    const response = await (sdk as any).fetch(`${server.url}/stream`, { signal: AbortSignal.timeout(1_000) })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("hello world")
    expect(envProxy.hits).toBe(0)
  } finally {
    envProxy.stop()
    server.stop()
    restoreProxyEnv(snapshot)
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
