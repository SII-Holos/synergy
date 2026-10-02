import { afterAll, expect, test } from "bun:test"
import { Provider } from "../../src/provider/provider"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

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
