import { afterEach, expect, test } from "bun:test"
import { ProviderSdkSource } from "../../src/provider/sdk-source"
import type { Provider as SDK } from "ai"
import { Provider } from "../../src/provider/provider"

afterEach(() => ProviderSdkSource.register(undefined))

test("unassembled harness rejects SDK access without loading a runtime", async () => {
  ProviderSdkSource.register(undefined)
  const model = {
    api: { npm: "@ai-sdk/openai", id: "research", url: "http://provider.invalid" },
    providerID: "research",
  } as Provider.Model
  expect(() => Provider.createSDKFromSpec(model, {})).toThrow("Provider SDK source is not registered")
  expect(() => ProviderSdkSource.loadSync("@ai-sdk/openai")).toThrow("Provider SDK source is not registered")
  await expect(ProviderSdkSource.load("@ai-sdk/openai")).rejects.toThrow("Provider SDK source is not registered")
})

test("explicit research SDK source serves synchronous and asynchronous factories", async () => {
  const sdk = { languageModel: () => ({ modelId: "research" }) } as unknown as SDK
  const factory = () => sdk
  ProviderSdkSource.register({
    load: async (name) => (name === "research" ? factory : undefined),
    loadSync: (name) => (name === "research" ? factory : undefined),
  })
  expect(ProviderSdkSource.loadSync("research")({})).toBe(sdk)
  expect((await ProviderSdkSource.load("research"))({})).toBe(sdk)
  expect(() => ProviderSdkSource.loadSync("missing")).toThrow('Unsupported provider SDK "missing"')
  await expect(ProviderSdkSource.load("missing")).rejects.toThrow('Unsupported provider SDK "missing"')
})
