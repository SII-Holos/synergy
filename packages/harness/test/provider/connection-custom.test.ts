import { describe, expect, test } from "bun:test"
import { Config } from "../../src/config/config"
import { Auth } from "../../src/provider/api-key"
import { ProviderConnection } from "../../src/provider/connection"
import { Provider } from "../../src/provider/provider"
import { ProviderSdkSource } from "../../src/provider/sdk-source"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { testRuntime } from "../support/runtime"
import type { Provider as SDK } from "ai"

const customInput = {
  id: "local-lab",
  name: "  Local Lab  ",
  endpoint: "https://lab.invalid/v1",
  protocol: "openai-completions" as const,
  models: [
    {
      id: "lab-chat",
      name: "Lab Chat",
      context: 200000,
      output: 32000,
      toolCall: true,
      image: true,
      reasoning: false,
    },
    { id: "lab-reason", context: 128000, output: 16000, toolCall: false, image: false, reasoning: true },
  ],
}

const customConfig = {
  name: "Local Lab",
  api: "https://lab.invalid/v1",
  npm: "@ai-sdk/openai-compatible",
  models: {
    "lab-chat": {
      name: "Lab Chat",
      limit: { context: 200000, output: 32000 },
      tool_call: true,
      reasoning: false,
      modalities: { input: ["text", "image"], output: ["text"] },
    },
    "lab-reason": {
      limit: { context: 128000, output: 16000 },
      tool_call: false,
      reasoning: true,
      modalities: { input: ["text"], output: ["text"] },
    },
  },
}

function persistedProvider(provider: Record<string, unknown> | undefined): Record<string, unknown> {
  const models = (provider?.models ?? {}) as Record<string, Record<string, unknown>>
  return {
    ...provider,
    models: Object.fromEntries(
      Object.entries(models).map(([modelID, model]) => [
        modelID,
        {
          name: model.name,
          limit: model.limit,
          tool_call: model.tool_call,
          reasoning: model.reasoning,
          modalities: model.modalities,
        },
      ]),
    ),
  }
}

const customInfo = {
  id: "local-lab",
  name: "Local Lab",
  profileID: "local-lab",
  catalogProviderID: "local-lab",
  endpoint: "https://lab.invalid/v1",
  enabled: true,
  configured: true,
  removable: true,
  canCreateSibling: false,
  protocol: "openai-completions" as const,
  models: [
    {
      id: "lab-chat",
      name: "Lab Chat",
      context: 200000,
      output: 32000,
      toolCall: true,
      image: true,
      reasoning: false,
    },
    { id: "lab-reason", context: 128000, output: 16000, toolCall: false, image: false, reasoning: true },
  ],
}

function inHome<T>(runtime: Awaited<ReturnType<typeof testRuntime>>, fn: () => Promise<T>) {
  return runtime.run(() => ScopeContext.provide({ scope: Scope.home(), fn }))
}

describe("ProviderConnection custom providers", () => {
  test("createCustom persists a config-only provider and returns editable custom metadata", async () => {
    await using runtime = await testRuntime()
    await inHome(runtime, async () => {
      const credentials = await Auth.entries()
      const { connection, change } = await ProviderConnection.createCustom(customInput)

      expect(connection).toEqual(customInfo)
      expect(change.oldConfig.provider?.["local-lab"]).toBeUndefined()
      expect(persistedProvider(change.config.provider?.["local-lab"])).toEqual(customConfig)
      const stored = await Config.domainGet("providers")
      expect(persistedProvider(stored.provider?.["local-lab"])).toEqual(customConfig)
      expect(Object.keys(stored.provider?.["local-lab"] ?? {}).sort()).toEqual(["api", "models", "name", "npm"])
      expect(stored.disabled_providers ?? []).toEqual([])
      expect(stored.enabled_providers ?? []).toEqual([])
      expect(await Auth.entries()).toEqual(credentials)

      expect((await ProviderConnection.list())["local-lab"]).toEqual(customInfo)
    })
  })

  test("createCustom rejects identifiers already owned by config, the catalog or a profile", async () => {
    await using runtime = await testRuntime()
    await inHome(runtime, async () => {
      await ProviderConnection.createCustom(customInput)
      const before = await Config.globalResolved()
      const credentials = await Auth.entries()

      for (const id of ["local-lab", "groq", "deepseek", "openai"]) {
        await expect(ProviderConnection.createCustom({ ...customInput, id })).rejects.toBeInstanceOf(
          ProviderConnection.AlreadyExists,
        )
      }
      expect(await Config.globalResolved()).toEqual(before)
      expect(await Auth.entries()).toEqual(credentials)
    })
  })

  test("custom input rejects invalid protocols, endpoints, models and duplicate model ids", () => {
    expect(ProviderConnection.Protocol.options).toEqual([
      "openai-completions",
      "openai-responses",
      "anthropic-messages",
    ])
    expect(ProviderConnection.CustomInput.parse(customInput)).toEqual({
      ...customInput,
      name: "Local Lab",
    })
    for (const patch of [
      { ...customInput, name: " " },
      { ...customInput, id: "Local_Lab" },
      { ...customInput, id: "x" },
      { ...customInput, endpoint: "ftp://lab.invalid/v1" },
      { ...customInput, endpoint: "lab.invalid/v1" },
      { ...customInput, protocol: "openai-chat" },
      { ...customInput, models: [] },
      { ...customInput, models: [{ ...customInput.models[0], context: 0 }] },
      { ...customInput, models: [{ ...customInput.models[0], output: -1 }] },
      { ...customInput, models: [{ ...customInput.models[0], context: 1.5 }] },
      { ...customInput, models: [{ ...customInput.models[0], id: "  " }] },
      { ...customInput, models: [customInput.models[0], { ...customInput.models[1], id: "lab-chat" }] },
      { ...customInput, models: [{ id: "lab-chat", context: 1, output: 1, toolCall: true }] },
      { ...customInput, profileID: "deepseek" },
      { ...customInput, enabled: false },
      { ...customInput, apiKey: "secret" },
    ]) {
      expect(ProviderConnection.CustomInput.safeParse(patch).success).toBe(false)
    }
  })

  test("update rewrites the custom protocol and model list without touching credentials", async () => {
    await using runtime = await testRuntime()
    await inHome(runtime, async () => {
      await ProviderConnection.createCustom(customInput)
      await Auth.set("local-lab", { type: "api", key: "custom-key" })
      const credentials = await Auth.entries()

      const { connection } = await ProviderConnection.update("local-lab", {
        name: "  Renamed Lab  ",
        endpoint: "https://lab-2.invalid/v1",
        protocol: "anthropic-messages",
        models: [{ id: "lab-anthropic", context: 64000, output: 8000, toolCall: true, image: false, reasoning: true }],
      })

      expect(connection).toEqual({
        id: "local-lab",
        name: "Renamed Lab",
        profileID: "local-lab",
        catalogProviderID: "local-lab",
        endpoint: "https://lab-2.invalid/v1",
        enabled: true,
        configured: true,
        removable: true,
        canCreateSibling: false,
        protocol: "anthropic-messages",
        models: [{ id: "lab-anthropic", context: 64000, output: 8000, toolCall: true, image: false, reasoning: true }],
      })
      expect(persistedProvider((await Config.domainGet("providers")).provider?.["local-lab"])).toEqual({
        name: "Renamed Lab",
        api: "https://lab-2.invalid/v1",
        npm: "@ai-sdk/anthropic",
        models: {
          "lab-anthropic": {
            limit: { context: 64000, output: 8000 },
            tool_call: true,
            reasoning: true,
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      })
      expect(await Auth.entries()).toEqual(credentials)
    })
  })

  test("update refuses an endpoint clear and custom metadata changes on canonical providers", async () => {
    await using runtime = await testRuntime()
    await inHome(runtime, async () => {
      await ProviderConnection.createCustom(customInput)
      const customBefore = await Config.globalResolved()

      await expect(ProviderConnection.update("local-lab", { endpoint: null })).rejects.toBeInstanceOf(
        ProviderConnection.CustomValidation,
      )
      await expect(ProviderConnection.update("local-lab", { endpoint: "ftp://lab.invalid/v1" })).rejects.toBeInstanceOf(
        ProviderConnection.CustomValidation,
      )
      expect(await Config.globalResolved()).toEqual(customBefore)

      const canonicalBefore = await Config.globalResolved()
      for (const patch of [
        { protocol: "anthropic-messages" as const },
        { models: [{ id: "m", context: 1, output: 1, toolCall: true, image: false, reasoning: false }] },
      ]) {
        await expect(ProviderConnection.update("deepseek", patch)).rejects.toBeInstanceOf(
          ProviderConnection.CustomValidation,
        )
      }
      expect(await Config.globalResolved()).toEqual(canonicalBefore)
      expect((await ProviderConnection.update("deepseek", { name: "Personal" })).connection).toMatchObject({
        name: "Personal",
        removable: false,
      })
    })
  })

  test("editing custom model fields preserves advanced settings and unrelated modalities", async () => {
    await using runtime = await testRuntime()
    await inHome(runtime, async () => {
      await ProviderConnection.createCustom(customInput)
      await Config.domainMutateWithChange(
        "providers",
        (domain) => {
          const provider = domain.provider!["local-lab"]
          const model = provider.models!["lab-chat"]
          model.options = { temperature: 0.2 }
          model.headers = { "x-model-header": "kept" }
          model.variants = { deep: { effort: "high" } }
          model.limit = { context: 200000, input: 180000, output: 32000 }
          model.modalities = { input: ["text", "image", "pdf"], output: ["text", "audio"] }
          return domain
        },
        { mode: "replace-domain" },
      )
      await ProviderConnection.update("local-lab", {
        name: "Renamed",
        protocol: "openai-responses",
        models: customInput.models,
      })
      const model = (await Config.domainGet("providers")).provider!["local-lab"].models!["lab-chat"]
      expect(model.options).toEqual({ temperature: 0.2 })
      expect(model.headers).toEqual({ "x-model-header": "kept" })
      expect(model.variants).toEqual({ deep: { effort: "high" } })
      expect(model.limit).toEqual({ context: 200000, input: 180000, output: 32000 })
      expect(model.modalities).toEqual({ input: ["text", "image", "pdf"], output: ["text", "audio"] })
      const { name: _name, ...withoutName } = customInput.models[0]
      await ProviderConnection.update("local-lab", { models: [withoutName, customInput.models[1]] })
      const cleared = (await Config.domainGet("providers")).provider!["local-lab"].models!["lab-chat"]
      expect(cleared.name).toBeUndefined()
      expect(cleared.options).toEqual({ temperature: 0.2 })
    })
  })

  test("remove deletes the custom provider, its enabled state and credentials after references clear", async () => {
    await using runtime = await testRuntime()
    await inHome(runtime, async () => {
      await ProviderConnection.createCustom(customInput)
      await Auth.set("local-lab", { type: "api", key: "custom-key" })
      await Config.updateGlobal({
        model: "local-lab/lab-chat",
        agent: { "custom-agent": { model: "local-lab/lab-reason" } },
      })

      await expect(ProviderConnection.remove("local-lab")).rejects.toMatchObject({
        data: { providerID: "local-lab", references: ["model", "agent.custom-agent.model"] },
      })
      expect(persistedProvider((await Config.domainGet("providers")).provider?.["local-lab"])).toEqual(customConfig)

      await Config.domainUpdate("models", { model: "deepseek/deepseek-chat" }, { mode: "replace-domain" })
      await Config.domainUpdate("agents", { agent: {} }, { mode: "replace-domain" })
      const { result } = await ProviderConnection.remove("local-lab")
      expect(result).toEqual({ providerID: "local-lab", removed: true })
      const stored = await Config.domainGet("providers")
      expect(stored.provider?.["local-lab"]).toBeUndefined()
      expect(stored.disabled_providers ?? []).not.toContain("local-lab")
      expect(stored.enabled_providers ?? []).not.toContain("local-lab")
      expect(await Auth.get("local-lab")).toBeUndefined()
      expect((await ProviderConnection.list())["local-lab"]).toBeUndefined()
    })
  })

  test("listFrom keeps custom connections out of the builtin service catalog", async () => {
    await using runtime = await testRuntime()
    await inHome(runtime, async () => {
      await ProviderConnection.createCustom(customInput)
      const config = await Config.globalResolved()
      const listed = ProviderConnection.listFrom(config, {})
      expect(listed["local-lab"]).toEqual(customInfo)
      expect(listed["local-lab"].canCreateSibling).toBe(false)
      expect(listed["local-lab"].name).toBe("Local Lab")
    })
  })

  test("configured custom npm reaches the runtime language model factory without a profile", async () => {
    const loads: string[] = []
    const create = (npm: string) => (options: Record<string, unknown>) => {
      loads.push(npm)
      return {
        languageModel: (id: string) => ({ kind: "languageModel", npm, id, options }),
        responses: (id: string) => ({ kind: "responses", npm, id, options }),
      } as unknown as SDK
    }
    await using runtime = await testRuntime({
      register() {
        ProviderSdkSource.register({
          load: async (name) => (name.startsWith("@ai-sdk/") ? create(name) : undefined),
          loadSync: (name) => (name.startsWith("@ai-sdk/") ? create(name) : undefined),
        })
      },
    })
    await inHome(runtime, async () => {
      const cases = [
        { protocol: "openai-completions" as const, npm: "@ai-sdk/openai-compatible", method: "languageModel" },
        { protocol: "openai-responses" as const, npm: "@ai-sdk/openai", method: "responses" },
        { protocol: "anthropic-messages" as const, npm: "@ai-sdk/anthropic", method: "languageModel" },
      ]
      for (const [index, item] of cases.entries()) {
        const id = `custom-runtime-${index}`
        await ProviderConnection.createCustom({
          ...customInput,
          id,
          name: `Runtime ${index}`,
          protocol: item.protocol,
          models: [customInput.models[0]],
        })
      }
      await Provider.reload()
      for (const [index, item] of cases.entries()) {
        const id = `custom-runtime-${index}`
        const provider = (await Provider.list())[id]
        expect(provider.profileID).toBeUndefined()
        const model = provider.models["lab-chat"]
        expect(model.api.npm).toBe(item.npm)
        expect(model.api.url).toBe("https://lab.invalid/v1")
        expect(model.api.id).toBe("lab-chat")
        expect(model.limit).toEqual({ context: 200000, input: undefined, output: 32000 })
        expect(model.capabilities.toolcall).toBe(true)
        expect(model.capabilities.input.image).toBe(true)

        const language = (await Provider.getLanguage(model)) as unknown as {
          kind: string
          npm: string
          id: string
        }
        expect(language).toMatchObject({ kind: item.method === "responses" ? "responses" : "languageModel" })
        expect(language.npm).toBe(item.npm)
        expect(language.id).toBe("lab-chat")
      }
      expect(loads).toEqual(["@ai-sdk/openai-compatible", "@ai-sdk/openai", "@ai-sdk/anthropic"])
    })
  })
})
