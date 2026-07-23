import { expect, test } from "bun:test"
import { Provider } from "../../src/provider/provider"

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
