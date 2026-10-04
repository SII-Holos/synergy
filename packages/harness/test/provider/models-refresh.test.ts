import { expect, spyOn, test } from "bun:test"
import { Global } from "../../src/global"
import { ModelsCatalog } from "../../src/provider/models"
import { testRuntime } from "../support/runtime"

function provider(id: string) {
  return {
    id,
    name: id,
    env: [],
    models: {
      fixture: {
        id: "fixture",
        name: "Fixture",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: false,
        temperature: false,
        tool_call: true,
        options: {},
        limit: { context: 4096, output: 1024 },
      },
    },
  }
}

function catalog(id: string) {
  return Object.fromEntries(["openai", "anthropic", "google", id].map((name) => [name, provider(name)]))
}

const invalidCatalogs: Array<[string, unknown]> = [
  ["empty catalog", {}],
  ["providers without models", { empty: { id: "empty", name: "Empty", env: [], models: {} } }],
  ["partial catalog", { partial: provider("partial") }],
  ["null provider", { broken: null }],
  ["null model", { broken: { ...provider("broken"), models: { bad: null } } }],
  [
    "malformed model",
    { broken: { ...provider("broken"), models: { bad: { id: "bad", name: "Bad", release_date: "2026-01-01" } } } },
  ],
]

test.each(invalidCatalogs)("catalog refresh preserves memory and disk for %s", async (_name, payload) => {
  await using runtime = await testRuntime({ env: { SYNERGY_DISABLE_MODELS_FETCH: "false" } })
  await runtime.run(async () => {
    const initial = catalog("initial")
    let response: unknown = initial
    using fetchMock = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(async () => Response.json(response), { preconnect: globalThis.fetch.preconnect }),
    )
    expect(await ModelsCatalog.refresh()).toEqual({ status: "refreshed", rejectedProviders: 0, rejectedModels: 0 })
    const before = await Bun.file(Global.Path.modelsCache).text()
    response = payload
    expect(await ModelsCatalog.refresh()).toEqual({ status: "failed" })
    expect(await ModelsCatalog.get()).toEqual(initial)
    expect(await Bun.file(Global.Path.modelsCache).text()).toBe(before)
  })
})

test.each(["invalid-json", "http", "network", "body"] as const)(
  "catalog refresh preserves the valid cache after %s failure",
  async (mode) => {
    await using runtime = await testRuntime({ env: { SYNERGY_DISABLE_MODELS_FETCH: "false" } })
    await runtime.run(async () => {
      const initial = catalog("initial")
      let failing = false
      using fetchMock = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
          async () => {
            if (!failing) return Response.json(initial)
            if (mode === "network") throw new Error("Fixture network failure")
            if (mode === "http") return new Response("Unavailable", { status: 503 })
            if (mode === "invalid-json") return new Response("not JSON")
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(new Error("Fixture body failure"))
                },
              }),
            )
          },
          { preconnect: globalThis.fetch.preconnect },
        ),
      )
      await ModelsCatalog.refresh()
      const before = await Bun.file(Global.Path.modelsCache).text()
      failing = true
      expect(await ModelsCatalog.refresh()).toEqual({ status: "failed" })
      expect(await ModelsCatalog.get()).toEqual(initial)
      expect(await Bun.file(Global.Path.modelsCache).text()).toBe(before)
    })
  },
)

test("catalog mirror fallback publishes valid entries and records rejected providers and models", async () => {
  await using runtime = await testRuntime({ env: { SYNERGY_DISABLE_MODELS_FETCH: "false" } })
  await runtime.run(async () => {
    const next = catalog("refreshed")
    const payload = {
      ...next,
      broken: null,
      refreshed: { ...next.refreshed, models: { ...next.refreshed!.models, bad: null } },
    }
    const requests: string[] = []
    using fetchMock = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: RequestInfo | URL) => {
          const url = String(input)
          requests.push(url)
          return url === "https://models.dev/api.json"
            ? new Response("Unavailable", { status: 503 })
            : Response.json(payload)
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    )
    expect(await ModelsCatalog.refresh()).toEqual({ status: "refreshed", rejectedProviders: 1, rejectedModels: 1 })
    expect(requests).toEqual([
      "https://models.dev/api.json",
      "https://raw.githubusercontent.com/SII-Holos/synergy-provider-registry/main/models.json",
    ])
    expect(await ModelsCatalog.get()).toEqual(next)
    expect(await Bun.file(Global.Path.modelsCache).json()).toEqual(next)
  })
})
