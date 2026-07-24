import { expect, test } from "bun:test"
import { Provider } from "../../src/provider/provider"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"

test("Agent worker provider plans retain data options without executable callbacks", () => {
  const fetch = () => Promise.resolve(new Response())
  const provider = {
    key: "private-key",
    options: {
      baseURL: "https://provider.invalid/v1",
      fetch,
      nested: {
        headers: { "x-provider": "test" },
        transform() {},
      },
    },
  } as unknown as Provider.Info

  const plan = Provider.workerPlan(provider)

  expect(plan).toEqual({
    key: "private-key",
    options: {
      baseURL: "https://provider.invalid/v1",
      nested: {
        headers: { "x-provider": "test" },
      },
    },
  })
  expect(provider.options.fetch).toBe(fetch)
})

test("Agent worker model caches follow provider credential changes", async () => {
  const previousWorker = process.env.SYNERGY_AGENT_WORKER
  process.env.SYNERGY_AGENT_WORKER = "1"
  const model = Provider.Model.parse({
    id: "credential-cache-model",
    providerID: "credential-cache-provider",
    api: {
      id: "credential-cache-model",
      url: "https://provider.invalid/v1",
      npm: "@ai-sdk/openai-compatible",
    },
    name: "Credential Cache Model",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 4_096, output: 1_024 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
    variants: {},
  })

  try {
    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        await Provider.configureWorkerProvider(model, { key: "first-key", options: {} })
        const first = await Provider.getLanguage(model)
        await Provider.configureWorkerProvider(model, { key: "second-key", options: {} })
        const second = await Provider.getLanguage(model)

        expect(second).not.toBe(first)
      },
    })
  } finally {
    if (previousWorker === undefined) delete process.env.SYNERGY_AGENT_WORKER
    else process.env.SYNERGY_AGENT_WORKER = previousWorker
  }
})
