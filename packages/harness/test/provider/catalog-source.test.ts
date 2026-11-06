import { expect, test } from "bun:test"
import { Provider } from "../../src/provider/provider"
import { ProviderCatalogSource } from "../../src/provider/catalog-source"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { testRuntime } from "../support/runtime"
import type { ModelsDev } from "../../src/provider/models-schemas"
import type { Provider as SDK } from "ai"
import { ProviderSdkSource } from "../../src/provider/sdk-source"
import { Auth } from "../../src/provider/api-key"
import { AgentTurnProtocol } from "../../src/session/agent-turn/protocol"
import { RolloutTransport } from "../../src/session/rollout/transport"

function provider(id: string): Provider.Info {
  const input: ModelsDev.Provider = {
    id,
    name: id,
    env: [],
    api: "https://example.invalid/v1",
    npm: "@ai-sdk/openai-compatible",
    models: {
      approved: {
        id: "approved",
        name: "Approved",
        release_date: "2026-10-01",
        attachment: false,
        reasoning: false,
        temperature: false,
        tool_call: true,
        limit: { context: 32000, output: 8000 },
        options: {},
      },
    },
  }
  return Provider.fromModelsDevProvider(input)
}

function inHome<T>(runtime: Awaited<ReturnType<typeof testRuntime>>, fn: () => Promise<T>) {
  return runtime.run(() => ScopeContext.provide({ scope: Scope.home(), fn }))
}

test("a host catalog is exclusive, isolated and sealed", async () => {
  const supplied = { managed: provider("managed") }
  await using first = await testRuntime({
    register: () => ProviderCatalogSource.register({ providers: async () => supplied }),
  })
  await using second = await testRuntime({
    register: () => ProviderCatalogSource.register({ providers: async () => ({}) }),
  })
  const actual = await inHome(first, Provider.list)
  expect(Object.keys(actual)).toEqual(["managed"])
  expect(Object.keys(actual.managed!.models)).toEqual(["approved"])
  supplied.managed.models = {}
  expect(Object.keys(actual.managed!.models)).toEqual(["approved"])
  expect(await inHome(second, Provider.list)).toEqual({})
  await inHome(first, async () => {
    await expect(Provider.getModel("openai", "gpt-4o")).rejects.toThrow()
    expect(() => ProviderCatalogSource.register({ providers: async () => ({}) })).toThrow("before opening the Runtime")
    const plan = await Provider.workerPlan(actual.managed, { ttfbMs: 1000, idleMs: 1000, wallMs: 1000 })
    expect(plan.authoritative).toBe(true)
  })
})

test("a serialized host-owned worker plan preserves credentials and transport evidence", async () => {
  let transport: ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | undefined
  const factory: ProviderSdkSource.Factory = (options) => {
    transport = options.fetch as typeof transport
    return { languageModel: () => ({ modelId: "approved" }) } as unknown as SDK
  }
  await using worker = await testRuntime({
    env: { SYNERGY_AGENT_WORKER: "1" },
    register: () => ProviderSdkSource.register({ load: async () => factory, loadSync: () => factory }),
  })
  await inHome(worker, async () => {
    const spec = provider("openai").models.approved!
    spec.api.npm = "fixture-sdk"
    await Auth.set("openai", { type: "api", key: "fixture-stored-key" })
    const plan = AgentTurnProtocol.TurnInputSchema.shape.prepared.shape.provider.parse({
      authoritative: true,
      key: "fixture-host-key",
      options: {},
      timeouts: { ttfbMs: 1000, idleMs: false, wallMs: false },
    })
    await Provider.configureWorkerProvider(spec, plan)
    let calls = 0
    await Provider.getSDK(spec, {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        calls++
        expect(new Request(input, init).headers.get("authorization")).toBe("Bearer fixture-host-key")
        return new Response("unauthorized", { status: 401 })
      },
    })
    if (!transport) throw new Error("SDK transport was not installed")
    const events: RolloutTransport.Event[] = []
    const response = await RolloutTransport.provide(
      async (event) => {
        events.push(event)
      },
      () => transport!("https://example.invalid/v1", { headers: { authorization: "Bearer fixture-host-key" } }),
    )
    await response.text()
    expect(calls).toBe(1)
    expect(events.length).toBeGreaterThan(0)
    expect(await Auth.get("openai")).toMatchObject({ key: "fixture-stored-key" })
  })
})

test("a failed or inconsistent host catalog never falls back to bundled models", async () => {
  for (const providers of [
    async () => {
      throw new Error("host catalog unavailable")
    },
    async () => ({ wrong: provider("managed") }),
  ]) {
    await using runtime = await testRuntime({ register: () => ProviderCatalogSource.register({ providers }) })
    await expect(inHome(runtime, Provider.list)).rejects.toThrow()
  }
})
