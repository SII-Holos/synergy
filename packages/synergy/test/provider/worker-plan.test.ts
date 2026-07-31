import { expect, test } from "bun:test"
import { Auth } from "../../src/provider/api-key"
import { Provider } from "../../src/provider/provider"
import { ProviderProfile } from "../../src/provider/profile"
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

  const plan = Provider.workerPlan(provider, {
    ttfbMs: 10,
    idleMs: 20,
    wallMs: false as const,
  })

  expect(plan).toEqual({
    key: "private-key",
    options: {
      baseURL: "https://provider.invalid/v1",
      nested: {
        headers: { "x-provider": "test" },
      },
    },
    timeouts: {
      ttfbMs: 10,
      idleMs: 20,
      wallMs: false as const,
    },
  })
  expect(provider.options.fetch).toBe(fetch)
})

test("Agent worker provider plans retain canonical runtime profile identity", () => {
  const provider = {
    profileID: "canonical-provider",
    options: {},
  } as unknown as Provider.Info

  expect(
    Provider.workerPlan(provider, {
      ttfbMs: 10,
      idleMs: 20,
      wallMs: false,
    }),
  ).toMatchObject({
    profileID: "canonical-provider",
  })
})

test("Agent worker profile hooks receive inline provider and model credentials", async () => {
  const previousWorker = process.env.SYNERGY_AGENT_WORKER
  process.env.SYNERGY_AGENT_WORKER = "1"
  const providerID = `worker-inline-auth-${Math.random().toString(36).slice(2)}`
  const runtimeAuthKeys: Array<string | undefined> = []
  ProviderProfile.register({
    id: providerID,
    name: "Worker inline auth test",
    authKind: "api_key",
    aiSdkPackage: "@ai-sdk/openai-compatible",
    runtimeOptions: async ({ auth }) => {
      runtimeAuthKeys.push(auth?.type === "api" ? auth.key : undefined)
      return {}
    },
  })
  const model = Provider.Model.parse({
    id: "worker-inline-model",
    providerID,
    api: {
      id: "worker-inline-model",
      url: "https://provider.invalid/v1",
      npm: "@ai-sdk/openai-compatible",
    },
    name: "Worker Inline Model",
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
    options: { apiKey: "inline-model-key" },
    headers: {},
    release_date: "2026-01-01",
    variants: {},
  })

  try {
    await Auth.set(providerID, { type: "api", key: "stored-provider-key" })
    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        await Provider.configureWorkerProvider(model, {
          profileID: providerID,
          key: "inline-provider-key",
          options: { apiKey: "profile-placeholder" },
          timeouts: { ttfbMs: 10, idleMs: 20, wallMs: false },
        })
        await Provider.configureWorkerProvider(
          { ...model, options: {} },
          {
            profileID: providerID,
            key: "inline-provider-key",
            options: { apiKey: "profile-placeholder" },
            timeouts: { ttfbMs: 10, idleMs: 20, wallMs: false },
          },
        )
      },
    })

    expect(runtimeAuthKeys).toEqual(["inline-model-key", "inline-provider-key"])
  } finally {
    await Auth.remove(providerID)
    if (previousWorker === undefined) delete process.env.SYNERGY_AGENT_WORKER
    else process.env.SYNERGY_AGENT_WORKER = previousWorker
  }
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
        await Provider.configureWorkerProvider(model, {
          key: "first-key",
          options: {},
          timeouts: { ttfbMs: 10, idleMs: 20, wallMs: false as const },
        })
        const first = await Provider.getLanguage(model)
        await Provider.configureWorkerProvider(model, {
          key: "second-key",
          options: {},
          timeouts: { ttfbMs: 10, idleMs: 20, wallMs: false as const },
        })
        const second = await Provider.getLanguage(model)

        expect(second).not.toBe(first)
      },
    })
  } finally {
    if (previousWorker === undefined) delete process.env.SYNERGY_AGENT_WORKER
    else process.env.SYNERGY_AGENT_WORKER = previousWorker
  }
})

test("Agent worker connection options override runtime profile defaults", async () => {
  const previousWorker = process.env.SYNERGY_AGENT_WORKER
  process.env.SYNERGY_AGENT_WORKER = "1"
  const providerID = `worker-profile-${Math.random().toString(36).slice(2)}`
  let receivedOptions: Record<string, unknown> | undefined
  ProviderProfile.register({
    id: providerID,
    name: "Worker profile precedence test",
    authKind: "none",
    aiSdkPackage: "@ai-sdk/openai-compatible",
    runtimeOptions: async () => ({
      baseURL: "https://profile.invalid/v1",
      headers: { "x-profile": "default" },
    }),
    getModel: async ({ options }) => {
      receivedOptions = options
      return {} as never
    },
  })
  const model = Provider.Model.parse({
    id: "worker-profile-model",
    providerID,
    api: {
      id: "worker-profile-model",
      url: "https://model.invalid/v1",
      npm: "@ai-sdk/openai-compatible",
    },
    name: "Worker Profile Model",
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
        await Provider.configureWorkerProvider(model, {
          profileID: providerID,
          key: "connection-key",
          options: {
            baseURL: "https://connection.invalid/v1",
            headers: { "x-connection": "selected" },
          },
          timeouts: { ttfbMs: 10, idleMs: 20, wallMs: false },
        })
        await Provider.getLanguage(model)
      },
    })

    expect(receivedOptions).toMatchObject({
      baseURL: "https://connection.invalid/v1",
      headers: {
        "x-profile": "default",
        "x-connection": "selected",
      },
    })
  } finally {
    if (previousWorker === undefined) delete process.env.SYNERGY_AGENT_WORKER
    else process.env.SYNERGY_AGENT_WORKER = previousWorker
  }
})
