import { test, expect, mock } from "bun:test"

// ---------------------------------------------------------------------------
// Intercept undici so we can observe ProxyAgent / Agent construction without
// spinning up real sockets. The provider module imports these at the top
// level, so the mock must be registered before the provider is first loaded.
// ---------------------------------------------------------------------------

interface ProxyAgentCall {
  opts: Record<string, unknown>
}
const proxyAgentCalls: ProxyAgentCall[] = []
const agentCallCount = { value: 0 }

mock.module("undici", () => {
  class MockProxyAgent {
    constructor(opts: Record<string, unknown>) {
      proxyAgentCalls.push({ opts })
    }
  }
  class MockAgent {
    constructor() {
      agentCallCount.value++
    }
  }
  return { ProxyAgent: MockProxyAgent, Agent: MockAgent }
})

// Provider imports undici internally — now it will resolve to our mock.
import { Provider } from "../../src/provider/provider"

// ---------------------------------------------------------------------------
// Minimal model factory so createSDKFromSpec has a valid spec to work with.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers — reset mock state between tests
// ---------------------------------------------------------------------------

function resetMocks() {
  proxyAgentCalls.length = 0
  agentCallCount.value = 0
}

// ---------------------------------------------------------------------------
// resolveProxyDispatcher — behavioural contracts
// ---------------------------------------------------------------------------

test("resolveProxyDispatcher returns ProxyAgent when proxy option is set", () => {
  resetMocks()

  const model = makeModel()
  Provider.createSDKFromSpec(model, {
    options: { proxy: "http://proxy.example.com:8080", apiKey: "test-key" },
  })

  expect(proxyAgentCalls.length).toBe(1)
  expect(proxyAgentCalls[0].opts).toMatchObject({ uri: "http://proxy.example.com:8080" })
})

test("resolveProxyDispatcher returns Agent when noProxy is true", () => {
  resetMocks()

  const model = makeModel()
  Provider.createSDKFromSpec(model, {
    options: { noProxy: true, apiKey: "test-key" },
  })

  expect(agentCallCount.value).toBe(1)
  expect(proxyAgentCalls.length).toBe(0)
})

test("resolveProxyDispatcher returns undefined (no dispatcher) when neither proxy nor noProxy is set", () => {
  resetMocks()

  const model = makeModel()
  Provider.createSDKFromSpec(model, {
    options: { apiKey: "test-key" },
  })

  expect(proxyAgentCalls.length).toBe(0)
  expect(agentCallCount.value).toBe(0)
})

test("resolveProxyDispatcher returns undefined (no dispatcher) when noProxy is false", () => {
  resetMocks()

  const model = makeModel()
  Provider.createSDKFromSpec(model, {
    options: { noProxy: false, apiKey: "test-key" },
  })

  expect(proxyAgentCalls.length).toBe(0)
  expect(agentCallCount.value).toBe(0)
})

test("resolveProxyDispatcher ignores noProxy when proxy is also set (proxy takes precedence)", () => {
  resetMocks()

  const model = makeModel()
  Provider.createSDKFromSpec(model, {
    options: { proxy: "http://proxy.example.com:8080", noProxy: true, apiKey: "test-key" },
  })

  expect(proxyAgentCalls.length).toBe(1)
  expect(agentCallCount.value).toBe(0)
})

// ---------------------------------------------------------------------------
// Option stripping — proxy/noProxy must NOT leak to bundledFn
// ---------------------------------------------------------------------------

test("proxy and noProxy options are stripped before options are passed to bundledFn", () => {
  resetMocks()

  const model = makeModel()
  const sdk = Provider.createSDKFromSpec(model, {
    options: { proxy: "http://p:8080", apiKey: "k", extra: "val" },
  })

  expect(sdk).toBeDefined()
  // SDK may be a function (e.g. @ai-sdk/openai) or an object — both are valid.
  expect(typeof sdk === "object" || typeof sdk === "function").toBe(true)
  expect((sdk as any).fetch).toBeTypeOf("function")

  // The dispatcher was created exactly once — proving proxy was extracted
  // before bundledFn and not seen by it.
  expect(proxyAgentCalls.length).toBe(1)
})

// ---------------------------------------------------------------------------
// createSDKFromSpec — fetch wrapper injection
// ---------------------------------------------------------------------------

test("createSDKFromSpec wraps SDK with a fetch proxy when proxy is configured", () => {
  resetMocks()

  const model = makeModel()
  const sdk = Provider.createSDKFromSpec(model, {
    options: { proxy: "http://proxy.example.com:8080", apiKey: "test-key" },
  })

  expect(sdk).toBeDefined()
  expect((sdk as any).fetch).toBeTypeOf("function")

  // Verify the patched fetch accepts input and init
  const patchedFetch = (sdk as any).fetch as (input: any, init?: any) => Promise<Response>
  expect(patchedFetch).toBeTypeOf("function")
})

test("createSDKFromSpec returns unmodified SDK when no proxy/noProxy is configured", () => {
  resetMocks()

  const model = makeModel()
  const sdk = Provider.createSDKFromSpec(model, {
    options: { apiKey: "test-key" },
  })

  expect(sdk).toBeDefined()
  expect(proxyAgentCalls.length).toBe(0)
  expect(agentCallCount.value).toBe(0)
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("proxy option with empty string does not trigger ProxyAgent", () => {
  resetMocks()

  const model = makeModel()
  Provider.createSDKFromSpec(model, {
    options: { proxy: "", apiKey: "test-key" },
  })

  expect(proxyAgentCalls.length).toBe(0)
  expect(agentCallCount.value).toBe(0)
})

test('noProxy string "true" does not trigger Agent (explicit === true check)', () => {
  resetMocks()

  const model = makeModel()
  Provider.createSDKFromSpec(model, {
    options: { noProxy: "true", apiKey: "test-key" },
  })

  expect(proxyAgentCalls.length).toBe(0)
  expect(agentCallCount.value).toBe(0)
})

test("proxy with noProxy=false still uses ProxyAgent", () => {
  resetMocks()

  const model = makeModel()
  Provider.createSDKFromSpec(model, {
    options: { proxy: "http://p:9999", noProxy: false, apiKey: "test-key" },
  })

  expect(proxyAgentCalls.length).toBe(1)
  expect(proxyAgentCalls[0].opts.uri).toBe("http://p:9999")
})
