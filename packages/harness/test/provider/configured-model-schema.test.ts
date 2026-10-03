import { afterAll, expect, test } from "bun:test"
import { Provider } from "../../src/provider/provider"
import { ModelsDev } from "../../src/provider/models-schemas"
import { ProviderSdkSource } from "../../src/provider/sdk-source"
import type { Provider as SDK } from "ai"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("catalog models without endpoints validate and retain SDK connection defaults", async () => {
  const catalog = ModelsDev.Provider.parse({
    id: "sdk-default",
    name: "SDK default",
    npm: "fixture-sdk",
    env: [],
    models: {
      model: {
        id: "model",
        name: "Model",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: false,
        tool_call: false,
        limit: { context: 64000, output: 4096 },
      },
    },
  })
  const provider = Provider.fromModelsDevProvider(catalog)
  expect(Provider.Info.safeParse(provider).success).toBe(true)
  const calls: Record<string, unknown>[] = []
  const sdk = { languageModel: () => ({ modelId: "model" }) } as unknown as SDK
  const factory = (options: Record<string, unknown>) => {
    calls.push(options)
    return sdk
  }
  await using owned = await testRuntime({
    composition: {
      register() {
        ProviderSdkSource.register({ load: async () => factory, loadSync: () => factory })
      },
    },
  })
  await owned.run(async () => {
    expect(Provider.createSDKFromSpec(provider.models.model, {})).toBe(sdk)
    expect(calls[0]).not.toHaveProperty("baseURL")
    Provider.createSDKFromSpec(provider.models.model, { options: { baseURL: "https://custom.example.invalid" } })
    expect(calls[1].baseURL).toBe("https://custom.example.invalid")
    const explicit = Provider.fromModelsDevProvider({ ...catalog, api: "https://catalog.example.invalid" })
    Provider.createSDKFromSpec(explicit.models.model, {})
    expect(calls[2].baseURL).toBe("https://catalog.example.invalid")
    await using fixture = await tmpdir({
      init: (directory) =>
        Bun.write(
          `${directory}/.synergy/synergy.d/20-providers.jsonc`,
          JSON.stringify({
            provider: {
              "sdk-default": {
                npm: "fixture-sdk",
                models: { model: { name: "Model", limit: { context: 64000, output: 4096 } } },
              },
            },
          }),
        ).then(() => {}),
    })
    await ScopeContext.provide({
      scope: await fixture.scope(),
      fn: async () => {
        expect(await Provider.getSDK(provider.models.model)).toBe(sdk)
        expect(calls[3]).not.toHaveProperty("baseURL")
      },
    })
  })
})

test("custom model metadata includes the configured SDK endpoint without a catalog entry", () =>
  runtime.run(async () => {
    await using fixture = await tmpdir({
      init: (directory) =>
        Bun.write(
          `${directory}/.synergy/synergy.d/20-providers.jsonc`,
          JSON.stringify({
            provider: {
              "custom-display": {
                npm: "@ai-sdk/openai-compatible",
                options: { baseURL: "https://model.example.invalid/v1", apiKey: "fixture" },
                models: { model: { name: "Custom model", limit: { context: 64000, output: 4096 } } },
              },
            },
          }),
        ).then(() => {}),
    })
    await ScopeContext.provide({
      scope: await fixture.scope(),
      fn: async () => {
        const provider = (await Provider.listConfiguredForClient())["custom-display"]
        expect(provider).toBeDefined()
        const model = Provider.Model.parse(provider.models.model)
        expect(model.api.url).toBe("https://model.example.invalid/v1")
      },
    })
  }))
