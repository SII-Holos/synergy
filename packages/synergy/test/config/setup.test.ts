import { expect, test } from "bun:test"
import { ConfigSetup } from "../../src/config/setup"
import { ProviderProfile } from "../../src/provider/profile"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

test("vision_model requires image input rather than another non-text modality", async () => {
  await using tmp = await tmpdir()
  await ScopeContext.provide({
    scope: await tmp.scope(),
    async fn() {
      const provider = {
        id: "pdf-provider",
        name: "PDF Provider",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        api: "https://example.test/v1",
        models: {
          "pdf-only": {
            id: "pdf-only",
            name: "PDF Only",
            family: "pdf",
            modalities: { input: ["text", "pdf"], output: ["text"] },
            limit: { context: 8_192, output: 1_024 },
          },
        },
      } satisfies NonNullable<ConfigSetup.SetupDraft["provider"]>[string]
      const result = await ConfigSetup.validateRequiredCore({
        model: "pdf-provider/pdf-only",
        vision_model: "pdf-provider/pdf-only",
        provider: { "pdf-provider": provider },
      })

      expect(result.fields.model.valid).toBe(true)
      expect(result.fields.vision_model.valid).toBe(false)
      expect(result.fields.vision_model.message).toBe("Vision model must support image input")
    },
  })
})

test("mapped provider models validate through their configured catalog source", async () => {
  await using tmp = await tmpdir()
  await ScopeContext.provide({
    scope: await tmp.scope(),
    async fn() {
      const result = await ConfigSetup.validateRequiredCore({
        model: "openai-secondary/gpt-4o",
        provider: {
          "openai-secondary": {
            profile: "openai",
            modelsDevProviderID: "openai",
            options: { apiKey: "test-api-key" },
          },
        },
      })

      expect(result.fields.model).toMatchObject({
        valid: true,
        mode: "static",
        message: "Default model verified",
      })
    },
  })
})

test("mapped provider models validate through synthetic profile catalogs", async () => {
  await using tmp = await tmpdir()
  await ScopeContext.provide({
    scope: await tmp.scope(),
    async fn() {
      const result = await ConfigSetup.validateRequiredCore({
        model: "codex-secondary/gpt-5.4-mini",
        provider: {
          "codex-secondary": {
            profile: "openai-codex",
            modelsDevProviderID: "openai-codex",
            options: { apiKey: "test-api-key" },
          },
        },
      })

      expect(result.fields.model).toMatchObject({
        valid: true,
        mode: "static",
        message: "Default model verified",
      })
    },
  })
})

test("mapped provider live probes run profile auth, options, and model hooks", async () => {
  const profileID = `setup-probe-profile-${Math.random().toString(36).slice(2)}`
  const providerID = `${profileID}-secondary`
  const calls: string[] = []
  let receivedOptions: Record<string, any> | undefined

  const unregister = ProviderProfile.register({
    id: profileID,
    name: "Setup probe profile",
    modelsDevProviderID: "openai",
    resolveAuth: async ({ providerID: resolvedProviderID, auth, provider }) => {
      expect(resolvedProviderID).toBe(providerID)
      expect(auth).toEqual({ type: "api", key: "setup-probe-key" })
      expect(provider?.id).toBe(providerID)
      calls.push("resolveAuth")
      return auth
    },
    modelOptions: async () => {
      calls.push("modelOptions")
      return { modelHook: true }
    },
    runtimeOptions: async () => {
      calls.push("runtimeOptions")
      return { runtimeHook: true, baseURL: "https://profile.invalid/v1" }
    },
    getModel: async ({ modelID, options }) => {
      calls.push("getModel")
      receivedOptions = options
      return {
        specificationVersion: "v2",
        provider: profileID,
        modelId: modelID,
        supportedUrls: {},
        async doGenerate() {
          return {
            content: [{ type: "text", text: "OK" }],
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            warnings: [],
          }
        },
      } as any
    },
  })

  try {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      async fn() {
        const result = await ConfigSetup.probeImportedCore({
          model: `${providerID}/gpt-4o`,
          provider: {
            [providerID]: {
              profile: profileID,
              modelsDevProviderID: "openai",
              api: "https://connection.invalid/v1",
              options: { apiKey: "setup-probe-key", connectionHook: true },
            },
          },
        })

        expect(result.fields.model).toMatchObject({
          valid: true,
          mode: "live",
          message: "Default model passed a live probe",
        })
        expect(calls).toEqual(["resolveAuth", "modelOptions", "runtimeOptions", "getModel"])
        expect(receivedOptions).toMatchObject({
          apiKey: "setup-probe-key",
          baseURL: "https://connection.invalid/v1",
          modelHook: true,
          runtimeHook: true,
          connectionHook: true,
        })
      },
    })
  } finally {
    unregister()
  }
  expect(ProviderProfile.get(profileID)).toBeUndefined()
})
