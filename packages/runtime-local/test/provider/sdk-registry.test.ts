import { expect, test } from "bun:test"
import { pathToFileURL } from "node:url"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ProviderSdkSource } from "@ericsanchezok/synergy-harness/provider/sdk-source"
import { registerLocalProviderSdks } from "../../src/provider/sdk-registry"

const packages = [
  "amazon-bedrock",
  "anthropic",
  "azure",
  "google",
  "google-vertex",
  "google-vertex/anthropic",
  "openai",
  "openai-compatible",
  "xai",
  "mistral",
  "groq",
  "deepinfra",
  "cerebras",
  "cohere",
  "gateway",
  "togetherai",
  "perplexity",
  "vercel",
]
  .map((name) => `@ai-sdk/${name}`)
  .concat("@openrouter/ai-sdk-provider")

test("local composition supplies all bundled SDK factories on both provider paths", async () => {
  registerLocalProviderSdks()
  for (const name of packages) {
    expect(typeof ProviderSdkSource.loadSync(name), name).toBe("function")
    expect(typeof (await ProviderSdkSource.load(name)), name).toBe("function")
  }
})

test("local runtime loads an explicitly configured custom SDK module", async () => {
  registerLocalProviderSdks()
  await using fixture = await tmpdir({
    init: async (directory) => {
      await Bun.write(
        path.join(directory, "sdk.ts"),
        "export function createResearch(options) { return { languageModel: () => ({ modelId: options.name }) } }",
      )
    },
  })
  const packageName = pathToFileURL(path.join(fixture.path, "sdk.ts")).href
  const factory = await ProviderSdkSource.load(packageName)
  expect(factory({ name: "research" }).languageModel("model")).toMatchObject({ modelId: "research" })
  expect(() => ProviderSdkSource.loadSync(packageName)).toThrow("Unsupported provider SDK")
})
