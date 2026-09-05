import { test, expect } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Provider } from "../../src/provider/provider"
import { Config } from "../../src/config/config"
import { Env } from "../../src/util/env"
import { ModelsDev } from "../../src/provider/models"
import { Provider as ProviderConfig } from "../../src/config/schema"
import { ProviderCatalog } from "../../src/provider/catalog"
import { ProviderProfile } from "../../src/provider/profile"
import { ProviderUsage } from "../../src/provider/usage-service"
import { Auth } from "../../src/provider/api-key"
import { registerBuiltinProviderProfiles } from "../../src/provider/builtin"
import { ProviderAuthHealth } from "../../src/provider/auth-health"

async function provideTestScope(input: {
  scope: Awaited<ReturnType<Awaited<ReturnType<typeof tmpdir>>["scope"]>>
  init?: () => Promise<void>
  fn: () => Promise<void>
}) {
  return ScopeContext.provide({
    scope: input.scope,
    async fn() {
      await input.init?.()
      return input.fn()
    },
  })
}

test("catalog reasoning efforts survive unrelated future option types", () => {
  const catalog = ModelsDev.Provider.parse({
    id: "openai",
    name: "OpenAI",
    api: "https://api.openai.com/v1",
    npm: "@ai-sdk/openai",
    env: [],
    models: {
      "future-reasoning-model": {
        id: "future-reasoning-model",
        name: "Future reasoning model",
        family: "gpt",
        release_date: "2026-07-01",
        attachment: true,
        reasoning: true,
        reasoning_options: [
          { type: "budget_tokens" },
          { type: "toggle" },
          { type: "effort", values: [null, "low", "max"] },
        ],
        temperature: false,
        tool_call: true,
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 128_000, output: 32_000 },
        options: {},
      },
    },
  })

  const model = Provider.fromModelsDevProvider(catalog).models["future-reasoning-model"]
  expect(Object.keys(model.variants ?? {})).toEqual(["low", "max"])
})

test("Kimi K3 catalog efforts become Anthropic-compatible variants", () => {
  const catalog = ModelsDev.Provider.parse({
    id: "kimi-for-coding",
    name: "Kimi For Coding",
    api: "https://api.kimi.com/coding/v1",
    npm: "@ai-sdk/anthropic",
    env: [],
    models: {
      k3: {
        id: "k3",
        name: "Kimi K3",
        family: "kimi-k3",
        release_date: "2026-07-16",
        attachment: false,
        reasoning: true,
        reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
        temperature: true,
        tool_call: true,
        modalities: { input: ["text", "image", "video"], output: ["text"] },
        limit: { context: 1_048_576, output: 131_072 },
        options: {},
      },
    },
  })

  const model = Provider.fromModelsDevProvider(catalog).models.k3
  expect(model.capabilities.reasoningEfforts).toEqual(["low", "high", "max"])
  expect(model.variants).toEqual({
    low: { effort: "low" },
    high: { effort: "high" },
    max: {},
  })
})

test.each([
  ["non-array options", { reasoning_options: {} }],
  ["non-array values", { reasoning_options: [{ type: "effort", values: {} }] }],
])("malformed catalog reasoning metadata falls back for %s", (_name, metadata) => {
  const model = {
    ...metadata,
    id: "gpt-5.6",
    release_date: "2026-07-01",
    reasoning: true,
  }
  expect(ModelsDev.reasoningEfforts(model as never)).toBeUndefined()
  const capabilities = Provider.mergeModelCapabilities(model as never)
  expect(capabilities.reasoningEfforts).toBeUndefined()
})

test("image media type capabilities normalize restrictions and allow explicit clearing", () => {
  const restricted = Provider.mergeModelCapabilities({
    supported_image_media_types: [" IMAGE/PNG ", "text/plain", "image/png"],
  })
  expect(restricted.input.supportedImageMediaTypes).toEqual(["image/png"])

  const cleared = Provider.mergeModelCapabilities({ supported_image_media_types: [] }, restricted)
  expect(cleared.input.supportedImageMediaTypes).toBeUndefined()
})

test.each([
  ["empty values", []],
  ["all invalid values", [null, 3]],
])("empty catalog reasoning efforts preserve provider fallbacks for %s", (_name, values) => {
  const capabilities = Provider.mergeModelCapabilities({
    reasoning: true,
    reasoning_options: [{ type: "effort", values }],
  })
  const variants = Provider.fromModelsDevProvider(
    ModelsDev.Provider.parse({
      id: "openai",
      name: "OpenAI",
      api: "https://api.openai.com/v1",
      npm: "@ai-sdk/openai",
      env: [],
      models: {
        "gpt-5.6": {
          id: "gpt-5.6",
          name: "GPT-5.6",
          release_date: "2026-07-01",
          attachment: true,
          reasoning: capabilities.reasoning,
          reasoning_options: [{ type: "effort", values }],
          temperature: false,
          tool_call: true,
          limit: { context: 128_000, output: 32_000 },
          options: {},
        },
      },
    }),
  ).models["gpt-5.6"].variants
  expect(Object.keys(variants ?? {})).toEqual(["none", "low", "medium", "high", "xhigh"])
})

test("provider loaded from env variable", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"]).toBeDefined()
      // Note: source becomes "custom" because the Anthropic provider profile
      // merges additional runtime options after env loading.
      expect(providers["anthropic"].source).toBe("custom")
    },
  })
})

test("provider loaded from config with apiKey option", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            anthropic: {
              options: {
                apiKey: "config-api-key",
              },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"]).toBeDefined()
    },
  })
})

test("disabled_providers excludes provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          disabled_providers: ["anthropic"],
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"]).toBeUndefined()
    },
  })
})

test("enabled_providers restricts to only listed providers", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          enabled_providers: ["anthropic"],
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
      Env.set("OPENAI_API_KEY", "test-openai-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"]).toBeDefined()
      expect(providers["openai"]).toBeUndefined()
    },
  })
})

test("model whitelist filters models for provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            anthropic: {
              whitelist: ["claude-sonnet-4-5"],
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"]).toBeDefined()
      const models = Object.keys(providers["anthropic"].models)
      expect(models).toContain("claude-sonnet-4-5")
      expect(models.length).toBe(1)
    },
  })
})

test("model blacklist excludes specific models", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            anthropic: {
              blacklist: ["claude-sonnet-4-5"],
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"]).toBeDefined()
      const models = Object.keys(providers["anthropic"].models)
      expect(models).not.toContain("claude-sonnet-4-5")
    },
  })
})

test("custom model alias via config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            anthropic: {
              models: {
                "my-alias": {
                  id: "claude-sonnet-4-5",
                  name: "My Custom Alias",
                },
              },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"]).toBeDefined()
      expect(providers["anthropic"].models["my-alias"]).toBeDefined()
      expect(providers["anthropic"].models["my-alias"].name).toBe("My Custom Alias")
    },
  })
})

test("custom provider with npm package", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            "custom-provider": {
              name: "Custom Provider",
              npm: "@ai-sdk/openai-compatible",
              api: "https://api.custom.com/v1",
              env: ["CUSTOM_API_KEY"],
              models: {
                "custom-model": {
                  name: "Custom Model",
                  tool_call: true,
                  limit: {
                    context: 128000,
                    output: 4096,
                  },
                },
              },
              options: {
                apiKey: "custom-key",
              },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["custom-provider"]).toBeDefined()
      expect(providers["custom-provider"].name).toBe("Custom Provider")
      expect(providers["custom-provider"].models["custom-model"]).toBeDefined()
    },
  })
})

test("provider config accepts a non-empty models.dev catalog source", () => {
  expect(ProviderConfig.parse({ modelsDevProviderID: "anthropic" }).modelsDevProviderID).toBe("anthropic")
  expect(ProviderConfig.safeParse({ modelsDevProviderID: "" }).success).toBe(false)
})

test("provider config accepts a non-empty canonical runtime profile", () => {
  expect(ProviderConfig.parse({ profile: "anthropic" }).profile).toBe("anthropic")
  expect(ProviderConfig.safeParse({ profile: "" }).success).toBe(false)
})

test("mapped Bedrock and SAP profiles consume connection auth and options", async () => {
  registerBuiltinProviderProfiles()
  const bedrockConnectionID = `bedrock-account-${Math.random().toString(36).slice(2)}`
  const sapConnectionID = `sap-account-${Math.random().toString(36).slice(2)}`
  const envNames = [
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_ACCESS_KEY_ID",
    "AWS_PROFILE",
    "AICORE_SERVICE_KEY",
    "AICORE_DEPLOYMENT_ID",
    "AICORE_RESOURCE_GROUP",
  ] as const
  const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]))
  for (const name of envNames) delete process.env[name]

  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          provider: {
            [bedrockConnectionID]: {
              profile: "amazon-bedrock",
              modelsDevProviderID: "amazon-bedrock",
              options: {
                region: "eu-west-1",
                baseURL: "https://bedrock.account.invalid",
              },
            },
            [sapConnectionID]: {
              profile: "sap-ai-core",
              modelsDevProviderID: "sap-ai-core",
              options: {
                deploymentId: "mapped-deployment",
                resourceGroup: "mapped-resource-group",
              },
            },
          },
        }),
      )
    },
  })

  try {
    await provideTestScope({
      scope: await tmp.scope(),
      fn: async () => {
        const bedrock = ProviderProfile.get("amazon-bedrock")!
        const bedrockInput = {
          providerID: bedrockConnectionID,
          auth: { type: "api" as const, key: "mapped-bedrock-token" },
        }
        expect(await bedrock.autoload!(bedrockInput)).toBe(true)
        expect(await bedrock.runtimeOptions!(bedrockInput)).toMatchObject({
          apiKey: "mapped-bedrock-token",
          region: "eu-west-1",
          baseURL: "https://bedrock.account.invalid",
        })

        const sap = ProviderProfile.get("sap-ai-core")!
        const sapInput = {
          providerID: sapConnectionID,
          auth: { type: "api" as const, key: "mapped-sap-service-key" },
        }
        expect(await sap.autoload!(sapInput)).toBe(true)
        expect(await sap.runtimeOptions!(sapInput)).toMatchObject({
          apiKey: "mapped-sap-service-key",
          deploymentId: "mapped-deployment",
          resourceGroup: "mapped-resource-group",
        })
        expect(Env.get("AICORE_SERVICE_KEY")).toBeUndefined()
      },
    })
  } finally {
    for (const name of envNames) {
      const value = previous[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test("mapped Cloudflare profile prefers the connection credential over the canonical environment", async () => {
  registerBuiltinProviderProfiles()
  const envNames = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID", "CLOUDFLARE_API_TOKEN"] as const
  const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]))

  try {
    await using tmp = await tmpdir()
    await provideTestScope({
      scope: await tmp.scope(),
      init: async () => {
        Env.set("CLOUDFLARE_ACCOUNT_ID", "account-id")
        Env.set("CLOUDFLARE_GATEWAY_ID", "gateway-id")
        Env.set("CLOUDFLARE_API_TOKEN", "canonical-token")
      },
      fn: async () => {
        const profile = ProviderProfile.get("cloudflare-ai-gateway")!
        const mapped = await profile.runtimeOptions!({
          providerID: "cloudflare-secondary",
          auth: { type: "api", key: "connection-token" },
        })
        expect(mapped.headers).toMatchObject({
          "cf-aig-authorization": "Bearer connection-token",
        })

        const canonical = await profile.runtimeOptions!({
          providerID: "cloudflare-ai-gateway",
          auth: undefined,
        })
        expect(canonical.headers).toMatchObject({
          "cf-aig-authorization": "Bearer canonical-token",
        })
      },
    })
  } finally {
    for (const name of envNames) {
      const value = previous[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test("Copilot Claude factories honor the merged connection endpoint", async () => {
  registerBuiltinProviderProfiles()
  for (const profileID of ["github-copilot", "github-copilot-enterprise"]) {
    const profile = ProviderProfile.get(profileID)!
    const model = await profile.getModel!({
      sdk: {},
      modelID: "claude-sonnet-4.6",
      options: {
        baseURL: "https://copilot-account.invalid",
        fetch,
      },
    })
    expect((model as any).config.baseURL).toBe("https://copilot-account.invalid")
  }
})

test("inline model credentials initialize mapped profiles and reach model loaders", async () => {
  const profileID = `inline-runtime-profile-${Math.random().toString(36).slice(2)}`
  const connectionID = `${profileID}-secondary`
  let loaderOptions: Record<string, any> | undefined
  const runtimeAuthKeys: string[] = []
  const oauthFetch = async () => new Response(null, { status: 200 })
  ProviderProfile.register({
    id: profileID,
    name: "Inline runtime profile",
    authKind: "api_key",
    modelsDevProviderID: "openai",
    aiSdkPackage: "@ai-sdk/openai",
    runtimeOptions: async ({ auth }) => {
      if (auth?.type === "api") runtimeAuthKeys.push(auth.key)
      return auth?.type === "oauth" ? { fetch: oauthFetch, authMode: "oauth" } : { authMode: "api" }
    },
    getModel: async ({ options }) => {
      loaderOptions = options
      return { specificationVersion: "v2", provider: profileID, modelId: "test" }
    },
  })

  await Auth.set(connectionID, {
    type: "oauth",
    access: "stored-oauth-access",
    refresh: "stored-oauth-refresh",
    expires: Math.floor(Date.now() / 1000) + 3600,
  })
  try {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "synergy.json"),
          JSON.stringify({
            provider: {
              [connectionID]: {
                profile: profileID,
                modelsDevProviderID: "openai",
                models: {
                  "gpt-5.5": {
                    options: {
                      apiKey: "inline-model-key",
                      baseURL: "https://inline-model.invalid/v1",
                    },
                  },
                },
              },
            },
          }),
        )
      },
    })

    await provideTestScope({
      scope: await tmp.scope(),
      fn: async () => {
        const provider = (await Provider.list())[connectionID]
        expect(provider.profileID).toBe(profileID)
        const model = await Provider.getModel(connectionID, "gpt-5.5")
        await Provider.getLanguage(model)
        expect(loaderOptions).toMatchObject({
          apiKey: "inline-model-key",
          baseURL: "https://inline-model.invalid/v1",
          authMode: "api",
        })
        expect(loaderOptions?.fetch).toBeUndefined()
        expect(runtimeAuthKeys).toContain("inline-model-key")
      },
    })
  } finally {
    await Auth.remove(connectionID)
  }
})

test("inline provider credentials initialize mapped profile auth", async () => {
  const profileID = `inline-provider-profile-${Math.random().toString(36).slice(2)}`
  const connectionID = `${profileID}-secondary`
  let resolvedKey: string | undefined
  ProviderProfile.register({
    id: profileID,
    name: "Inline provider profile",
    authKind: "api_key",
    modelsDevProviderID: "openai",
    aiSdkPackage: "@ai-sdk/openai",
    runtimeOptions: async ({ auth }) => {
      resolvedKey = auth?.type === "api" ? auth.key : undefined
      return {}
    },
  })

  await Auth.set(connectionID, { type: "api", key: "stored-provider-key" })
  try {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "synergy.json"),
          JSON.stringify({
            provider: {
              [connectionID]: {
                profile: profileID,
                modelsDevProviderID: "openai",
                options: {
                  apiKey: "inline-provider-key",
                },
              },
            },
          }),
        )
      },
    })

    await provideTestScope({
      scope: await tmp.scope(),
      fn: async () => {
        const provider = (await Provider.list())[connectionID]
        expect(provider.profileID).toBe(profileID)
        expect(provider.key).toBe("inline-provider-key")
        expect(resolvedKey).toBe("inline-provider-key")
        const plan = await Provider.workerPlan(provider, {
          ttfbMs: 10,
          idleMs: 20,
          wallMs: false,
        })
        expect(plan.baseOptions).toBeDefined()
        expect(plan.explicitOptions).toMatchObject({
          apiKey: "inline-provider-key",
        })
      },
    })
  } finally {
    await Auth.remove(connectionID)
  }
})

test("custom provider resolves runtime behavior through its canonical profile", async () => {
  const profileID = `runtime-profile-${Math.random().toString(36).slice(2)}`
  const connectionID = `${profileID}-secondary`
  ProviderProfile.register({
    id: profileID,
    name: "Runtime profile",
    authKind: "api_key",
    modelsDevProviderID: "openai",
    modelFactory: "openaiResponses",
    runtimeOptions: async ({ providerID, auth }) => ({
      baseURL: "https://canonical-profile.invalid/v1",
      resolvedProviderID: providerID,
      resolvedCredential: auth?.type === "api" ? auth.key : undefined,
    }),
    fetchUsage: async ({ providerID }) => ({
      providerID,
      status: "available",
      source: "test",
      fetchedAt: new Date().toISOString(),
      windows: [],
      details: [providerID],
    }),
  })
  ProviderCatalog.reset()

  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            [connectionID]: {
              profile: profileID,
              modelsDevProviderID: "openai",
              api: "https://secondary-profile.invalid/v1",
            },
          },
        }),
      )
    },
  })
  await Auth.set(connectionID, { type: "api", key: "secondary-profile-key" })
  try {
    await provideTestScope({
      scope: await tmp.scope(),
      fn: async () => {
        const provider = (await Provider.list())[connectionID]
        expect(provider.profileID).toBe(profileID)
        expect(provider.key).toBe("secondary-profile-key")
        expect(provider.options.resolvedProviderID).toBe(connectionID)
        expect(provider.options.resolvedCredential).toBe("secondary-profile-key")
        expect(provider.options.baseURL).toBe("https://secondary-profile.invalid/v1")
        expect(provider.models["gpt-5.5"].providerID).toBe(connectionID)
        expect(await ProviderUsage.get(connectionID)).toMatchObject({
          providerID: connectionID,
          status: "available",
          details: [connectionID],
        })
      },
    })
  } finally {
    await Auth.remove(connectionID)
  }
})

test("mapped OpenRouter usage uses inline and environment connection credentials", async () => {
  const originalFetch = globalThis.fetch
  const seen: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get("authorization") ?? "")
    const credits = String(input).endsWith("/credits")
    return new Response(
      JSON.stringify({
        data: credits ? { total_credits: 10, total_usage: 2 } : { limit: 10, limit_remaining: 8 },
      }),
      { headers: { "content-type": "application/json" } },
    )
  }) as typeof fetch

  try {
    for (const account of [
      {
        id: `openrouter-inline-${Math.random().toString(36).slice(2)}`,
        provider: { profile: "openrouter", options: { apiKey: "inline-openrouter-key" } },
        expected: "inline-openrouter-key",
      },
      {
        id: `openrouter-environment-${Math.random().toString(36).slice(2)}`,
        provider: { profile: "openrouter", env: ["MISSING_MAPPED_OPENROUTER_KEY", "MAPPED_OPENROUTER_KEY"] },
        expected: "environment-openrouter-key",
      },
    ]) {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "synergy.json"),
            JSON.stringify({
              provider: {
                [account.id]: account.provider,
              },
            }),
          )
        },
      })

      await provideTestScope({
        scope: await tmp.scope(),
        init: async () => {
          if (account.provider.env) Env.set("MAPPED_OPENROUTER_KEY", account.expected)
        },
        fn: async () => {
          expect((await Provider.list())[account.id].key).toBe(account.expected)
          expect(await ProviderUsage.get(account.id)).toMatchObject({
            providerID: account.id,
            status: "available",
            source: "credits_api",
          })
        },
      })
    }
  } finally {
    globalThis.fetch = originalFetch
  }

  expect(seen).toEqual([
    "Bearer inline-openrouter-key",
    "Bearer inline-openrouter-key",
    "Bearer environment-openrouter-key",
    "Bearer environment-openrouter-key",
  ])
})

test("environment-backed OpenRouter usage rejection requests an environment update", async () => {
  const providerID = `openrouter-environment-rejected-${Math.random().toString(36).slice(2)}`
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(null, { status: 401 })) as unknown as typeof fetch

  try {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "synergy.json"),
          JSON.stringify({
            provider: {
              [providerID]: {
                profile: "openrouter",
                env: ["MISSING_MAPPED_OPENROUTER_KEY", "MAPPED_OPENROUTER_KEY"],
              },
            },
          }),
        )
      },
    })

    await provideTestScope({
      scope: await tmp.scope(),
      init: async () => Env.set("MAPPED_OPENROUTER_KEY", "rejected-environment-openrouter-key"),
      fn: async () => {
        expect(await ProviderUsage.get(providerID)).toMatchObject({ status: "error" })
        expect(ProviderAuthHealth.fromEntry(providerID, undefined)).toMatchObject({
          status: "action_required",
          recovery: "update_environment",
          source: "env",
        })
      },
    })
  } finally {
    globalThis.fetch = originalFetch
    await ProviderAuthHealth.clearObservation(providerID)
  }
})

test("custom provider inherits a models.dev catalog without sharing account identity", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            "anthropic-secondary": {
              modelsDevProviderID: "anthropic",
              name: "Anthropic Secondary",
              npm: "@ai-sdk/openai-compatible",
              api: "https://secondary.example.test/v1",
              env: ["ANTHROPIC_SECONDARY_API_KEY"],
              models: {
                "claude-sonnet-4-5": {
                  id: "secondary-sonnet-api-id",
                  name: "Secondary Sonnet",
                },
              },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const primary = providers.anthropic
      const secondary = providers["anthropic-secondary"]
      const inherited = secondary.models["claude-sonnet-4-5"]
      const inheritedWithoutOverride = secondary.models["claude-opus-4-5"]

      expect(secondary.name).toBe("Anthropic Secondary")
      expect(secondary.env).toEqual(["ANTHROPIC_SECONDARY_API_KEY"])
      expect(inherited.name).toBe("Secondary Sonnet")
      expect(inherited.providerID).toBe("anthropic-secondary")
      expect(inherited.api.id).toBe("secondary-sonnet-api-id")
      expect(inherited.api.url).toBe("https://secondary.example.test/v1")
      expect(inherited.api.npm).toBe("@ai-sdk/openai-compatible")
      expect(inherited.limit.context).toBeGreaterThan(0)
      expect(inherited.capabilities.reasoning).toBe(true)
      expect(inheritedWithoutOverride.variants).toEqual({
        low: { reasoningEffort: "low" },
        medium: { reasoningEffort: "medium" },
        high: { reasoningEffort: "high" },
      })
      expect(primary.models["claude-sonnet-4-5"].providerID).toBe("anthropic")
      expect(primary.models["claude-sonnet-4-5"].name).not.toBe("Secondary Sonnet")
    },
  })
})

test("catalog-only connections are visible before credentials are connected", async () => {
  const connectionID = `catalog-only-${Math.random().toString(36).slice(2)}`
  const config = {
    provider: {
      [connectionID]: {
        modelsDevProviderID: "openai",
        name: "OpenAI Secondary",
      },
    },
  }

  const catalog = await ProviderCatalog.resolve({ config })

  expect(catalog[connectionID]).toBeDefined()
  expect(catalog[connectionID].id).toBe(connectionID)
  expect(catalog[connectionID].name).toBe("OpenAI Secondary")
  expect(catalog[connectionID].models["gpt-5.5"]).toBeDefined()
})

test("SDK cache identity includes the concrete account connection", async () => {
  const firstID = `sdk-account-a-${Math.random().toString(36).slice(2)}`
  const secondID = `sdk-account-b-${Math.random().toString(36).slice(2)}`
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            [firstID]: {
              modelsDevProviderID: "openai",
              npm: "@ai-sdk/openai-compatible",
              api: "https://shared.example.test/v1",
              env: ["SDK_ACCOUNT_A_KEY"],
            },
            [secondID]: {
              modelsDevProviderID: "openai",
              npm: "@ai-sdk/openai-compatible",
              api: "https://shared.example.test/v1",
              env: ["SDK_ACCOUNT_B_KEY"],
            },
          },
        }),
      )
    },
  })

  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("SDK_ACCOUNT_A_KEY", "shared-test-key")
      Env.set("SDK_ACCOUNT_B_KEY", "shared-test-key")
    },
    fn: async () => {
      const firstModel = await Provider.getModel(firstID, "gpt-5.5")
      const secondModel = await Provider.getModel(secondID, "gpt-5.5")
      const firstSDK = await Provider.getSDK(firstModel)
      const secondSDK = await Provider.getSDK(secondModel)

      expect(secondSDK).not.toBe(firstSDK)
    },
  })
})

test("custom provider inheritance excludes credential-aware live catalog snapshots", async () => {
  const profileID = `live-catalog-source-${Math.random().toString(36).slice(2)}`
  const connectionID = `${profileID}-secondary`
  ProviderProfile.register({
    id: profileID,
    name: "Live catalog source",
    authKind: "none",
    modelsDevProviderID: "openai",
    fallbackModels: ["gpt-5.5"],
    modelCatalogIdentity: () => "primary-account",
    fetchModelCatalog: async () => [{ id: "primary-account-only-model" }],
  })
  ProviderCatalog.reset()
  await ProviderCatalog.refresh(profileID)
  const liveCatalog = await ProviderCatalog.resolve({
    includeLive: true,
  })
  expect(liveCatalog[profileID].models["primary-account-only-model"]).toBeDefined()

  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            [connectionID]: {
              modelsDevProviderID: profileID,
              env: ["SECONDARY_API_KEY"],
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("SECONDARY_API_KEY", "secondary-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers[connectionID].models["primary-account-only-model"]).toBeUndefined()
      expect(providers[connectionID].models["gpt-5.5"]).toBeDefined()
    },
  })
})

test("custom provider live catalogs are discovered and cached per account connection", async () => {
  const profileID = `live-runtime-profile-${Math.random().toString(36).slice(2)}`
  const firstConnectionID = `${profileID}-first`
  const secondConnectionID = `${profileID}-second`
  ProviderProfile.register({
    id: profileID,
    name: "Live runtime profile",
    authKind: "none",
    modelsDevProviderID: "openai",
    fallbackModels: ["gpt-5.5"],
    fetchModelCatalog: async ({ providerID }) => [{ id: `${providerID}-model` }],
  })
  ProviderCatalog.reset()
  const config = {
    $schema: "file:///test/config.schema.json",
    provider: {
      [firstConnectionID]: {
        profile: profileID,
        modelsDevProviderID: "openai",
      },
      [secondConnectionID]: {
        profile: profileID,
        modelsDevProviderID: "openai",
      },
    },
  }

  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "synergy.json"), JSON.stringify(config))
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    fn: async () => {
      await ProviderCatalog.refresh(firstConnectionID)
      await ProviderCatalog.refresh(secondConnectionID)
      ProviderCatalog.reset()

      const catalog = await ProviderCatalog.resolve({ config, includeLive: true })
      expect(catalog[firstConnectionID].models[`${firstConnectionID}-model`]).toBeDefined()
      expect(catalog[firstConnectionID].models[`${secondConnectionID}-model`]).toBeUndefined()
      expect(catalog[secondConnectionID].models[`${secondConnectionID}-model`]).toBeDefined()
      expect(catalog[secondConnectionID].models[`${firstConnectionID}-model`]).toBeUndefined()
    },
  })
})

test("env variable takes precedence, config merges options", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            anthropic: {
              options: {
                timeout: 60000,
              },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "env-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"]).toBeDefined()
      // Config options should be merged
      expect(providers["anthropic"].options.timeout).toBe(60000)
    },
  })
})

test("getModel returns model for valid provider/model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const model = await Provider.getModel("anthropic", "claude-sonnet-4-5")
      expect(model).toBeDefined()
      expect(model.providerID).toBe("anthropic")
      expect(model.id).toBe("claude-sonnet-4-5")
    },
  })
})

test("getModel throws ModelNotFoundError for invalid model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      expect(Provider.getModel("anthropic", "nonexistent-model")).rejects.toThrow()
    },
  })
})

test("getModel throws ModelNotFoundError for invalid provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    fn: async () => {
      expect(Provider.getModel("nonexistent-provider", "some-model")).rejects.toThrow()
    },
  })
})

test("parseModel correctly parses provider/model string", () => {
  const result = Provider.parseModel("anthropic/claude-sonnet-4")
  expect(result.providerID).toBe("anthropic")
  expect(result.modelID).toBe("claude-sonnet-4")
})

test("parseModel handles model IDs with slashes", () => {
  const result = Provider.parseModel("openrouter/anthropic/claude-3-opus")
  expect(result.providerID).toBe("openrouter")
  expect(result.modelID).toBe("anthropic/claude-3-opus")
})

test("defaultModel returns first available model when no model config is set", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const model = await Provider.defaultModel()
      expect(model.providerID).toBeDefined()
      expect(model.modelID).toBeDefined()
    },
  })
})

test("defaultModel respects config model setting", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          model: "anthropic/claude-sonnet-4-5",
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const model = await Provider.defaultModel()
      expect(model.providerID).toBe("anthropic")
      expect(model.modelID).toBe("claude-sonnet-4-5")
    },
  })
})

test("provider with baseURL from config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            "custom-openai": {
              name: "Custom OpenAI",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "gpt-4": {
                  name: "GPT-4",
                  tool_call: true,
                  limit: { context: 128000, output: 4096 },
                },
              },
              options: {
                apiKey: "test-key",
                baseURL: "https://custom.openai.com/v1",
              },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["custom-openai"]).toBeDefined()
      expect(providers["custom-openai"].options.baseURL).toBe("https://custom.openai.com/v1")
    },
  })
})

test("model cost defaults to zero when not specified", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            "test-provider": {
              name: "Test Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "test-model": {
                  name: "Test Model",
                  tool_call: true,
                  limit: { context: 128000, output: 4096 },
                },
              },
              options: {
                apiKey: "test-key",
              },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["test-provider"].models["test-model"]
      expect(model.cost.input).toBe(0)
      expect(model.cost.output).toBe(0)
      expect(model.cost.cache.read).toBe(0)
      expect(model.cost.cache.write).toBe(0)
    },
  })
})

test("model options are merged from existing model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-5": {
                  options: {
                    customOption: "custom-value",
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["anthropic"].models["claude-sonnet-4-5"]
      expect(model.options.customOption).toBe("custom-value")
    },
  })
})

test("provider removed when all models filtered out", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            anthropic: {
              whitelist: ["nonexistent-model"],
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"]).toBeUndefined()
    },
  })
})

test("getModel uses realIdByKey for aliased models", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            anthropic: {
              models: {
                "my-sonnet": {
                  id: "claude-sonnet-4-5",
                  name: "My Sonnet Alias",
                },
              },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"].models["my-sonnet"]).toBeDefined()

      const model = await Provider.getModel("anthropic", "my-sonnet")
      expect(model).toBeDefined()
      expect(model.id).toBe("my-sonnet")
      expect(model.name).toBe("My Sonnet Alias")
    },
  })
})

test("provider api field sets model api.url", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            "custom-api": {
              name: "Custom API",
              npm: "@ai-sdk/openai-compatible",
              api: "https://api.example.com/v1",
              env: [],
              models: {
                "model-1": {
                  name: "Model 1",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
              options: {
                apiKey: "test-key",
              },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    fn: async () => {
      const providers = await Provider.list()
      // api field is stored on model.api.url, used by getSDK to set baseURL
      expect(providers["custom-api"].models["model-1"].api.url).toBe("https://api.example.com/v1")
    },
  })
})

test("explicit baseURL overrides api field", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            "custom-api": {
              name: "Custom API",
              npm: "@ai-sdk/openai-compatible",
              api: "https://api.example.com/v1",
              env: [],
              models: {
                "model-1": {
                  name: "Model 1",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
              options: {
                apiKey: "test-key",
                baseURL: "https://custom.override.com/v1",
              },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["custom-api"].options.baseURL).toBe("https://custom.override.com/v1")
    },
  })
})

test("model inherits properties from existing database model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-5": {
                  name: "Custom Name for Sonnet",
                },
              },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["anthropic"].models["claude-sonnet-4-5"]
      expect(model.name).toBe("Custom Name for Sonnet")
      expect(model.capabilities.toolcall).toBe(true)
      expect(model.capabilities.attachment).toBe(true)
      expect(model.limit.context).toBeGreaterThan(0)
    },
  })
})

test("disabled_providers prevents loading even with env var", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          disabled_providers: ["openai"],
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("OPENAI_API_KEY", "test-openai-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["openai"]).toBeUndefined()
    },
  })
})

test("enabled_providers with empty array is treated as unset", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          enabled_providers: [],
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
      Env.set("OPENAI_API_KEY", "test-openai-key")
    },
    fn: async () => {
      const config = await Config.current()
      expect(config.enabled_providers).toBeUndefined()
      const providers = await Provider.list()
      expect(providers["anthropic"]).toBeDefined()
      expect(providers["openai"]).toBeDefined()
    },
  })
})

test("disabled_providers with empty array is treated as unset", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          disabled_providers: [],
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("OPENAI_API_KEY", "test-openai-key")
    },
    fn: async () => {
      const config = await Config.current()
      expect(config.disabled_providers).toBeUndefined()
      const providers = await Provider.list()
      expect(providers["openai"]).toBeDefined()
    },
  })
})

test("whitelist and blacklist can be combined", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            anthropic: {
              whitelist: ["claude-sonnet-4-5", "claude-opus-4-5"],
              blacklist: ["claude-opus-4-5"],
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"]).toBeDefined()
      const models = Object.keys(providers["anthropic"].models)
      expect(models).toContain("claude-sonnet-4-5")
      expect(models).not.toContain("claude-opus-4-5")
      expect(models.length).toBe(1)
    },
  })
})

test("model modalities default correctly", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            "test-provider": {
              name: "Test",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "test-model": {
                  name: "Test Model",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["test-provider"].models["test-model"]
      expect(model.capabilities.input.text).toBe(true)
      expect(model.capabilities.output.text).toBe(true)
    },
  })
})

test("model with custom cost values", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            "test-provider": {
              name: "Test",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "test-model": {
                  name: "Test Model",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                  cost: {
                    input: 5,
                    output: 15,
                    cache_read: 2.5,
                    cache_write: 7.5,
                  },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["test-provider"].models["test-model"]
      expect(model.cost.input).toBe(5)
      expect(model.cost.output).toBe(15)
      expect(model.cost.cache.read).toBe(2.5)
      expect(model.cost.cache.write).toBe(7.5)
    },
  })
})

test("provider.sort prioritizes preferred models", () => {
  const models = [
    { id: "random-model", name: "Random" },
    { id: "claude-sonnet-4-latest", name: "Claude Sonnet 4" },
    { id: "gpt-5-turbo", name: "GPT-5 Turbo" },
    { id: "other-model", name: "Other" },
  ] as any[]

  const sorted = Provider.sort(models)
  expect(sorted[0].id).toContain("sonnet-4")
  expect(sorted[0].id).toContain("latest")
  expect(sorted[sorted.length - 1].id).not.toContain("gpt-5")
  expect(sorted[sorted.length - 1].id).not.toContain("sonnet-4")
})

test("multiple providers can be configured simultaneously", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            anthropic: {
              options: { timeout: 30000 },
            },
            openai: {
              options: { timeout: 60000 },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-anthropic-key")
      Env.set("OPENAI_API_KEY", "test-openai-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"]).toBeDefined()
      expect(providers["openai"]).toBeDefined()
      expect(providers["anthropic"].options.timeout).toBe(30000)
      expect(providers["openai"].options.timeout).toBe(60000)
    },
  })
})

test("provider with custom npm package", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            "local-llm": {
              name: "Local LLM",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "llama-3": {
                  name: "Llama 3",
                  tool_call: true,
                  limit: { context: 8192, output: 2048 },
                },
              },
              options: {
                apiKey: "not-needed",
                baseURL: "http://localhost:11434/v1",
              },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["local-llm"]).toBeDefined()
      expect(providers["local-llm"].models["llama-3"].api.npm).toBe("@ai-sdk/openai-compatible")
      expect(providers["local-llm"].options.baseURL).toBe("http://localhost:11434/v1")
    },
  })
})

// Edge cases for model configuration

test("model alias name defaults to alias key when id differs", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            anthropic: {
              models: {
                sonnet: {
                  id: "claude-sonnet-4-5",
                  // no name specified - should default to "sonnet" (the key)
                },
              },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"].models["sonnet"].name).toBe("sonnet")
    },
  })
})

test("provider with multiple env var options only includes apiKey when single env", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            "multi-env": {
              name: "Multi Env Provider",
              npm: "@ai-sdk/openai-compatible",
              env: ["MULTI_ENV_KEY_1", "MULTI_ENV_KEY_2"],
              models: {
                "model-1": {
                  name: "Model 1",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
              options: {
                baseURL: "https://api.example.com/v1",
              },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("MULTI_ENV_KEY_1", "test-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["multi-env"]).toBeDefined()
      // When multiple env options exist, key should NOT be auto-set
      expect(providers["multi-env"].key).toBeUndefined()
    },
  })
})

test("provider with single env var includes apiKey automatically", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            "single-env": {
              name: "Single Env Provider",
              npm: "@ai-sdk/openai-compatible",
              env: ["SINGLE_ENV_KEY"],
              models: {
                "model-1": {
                  name: "Model 1",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
              options: {
                baseURL: "https://api.example.com/v1",
              },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("SINGLE_ENV_KEY", "my-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["single-env"]).toBeDefined()
      // Single env option should auto-set key
      expect(providers["single-env"].key).toBe("my-api-key")
    },
  })
})

test("model cost overrides existing cost values", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-5": {
                  cost: {
                    input: 999,
                    output: 888,
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["anthropic"].models["claude-sonnet-4-5"]
      expect(model.cost.input).toBe(999)
      expect(model.cost.output).toBe(888)
    },
  })
})

test("completely new provider not in database can be configured", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            "brand-new-provider": {
              name: "Brand New",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              api: "https://new-api.com/v1",
              models: {
                "new-model": {
                  name: "New Model",
                  tool_call: true,
                  reasoning: true,
                  attachment: true,
                  temperature: true,
                  limit: { context: 32000, output: 8000 },
                  modalities: {
                    input: ["text", "image"],
                    output: ["text"],
                  },
                },
              },
              options: {
                apiKey: "new-key",
              },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["brand-new-provider"]).toBeDefined()
      expect(providers["brand-new-provider"].name).toBe("Brand New")
      const model = providers["brand-new-provider"].models["new-model"]
      expect(model.capabilities.reasoning).toBe(true)
      expect(model.capabilities.attachment).toBe(true)
      expect(model.capabilities.input.image).toBe(true)
    },
  })
})

test("configured model overrides preserve catalog reasoning efforts", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            openai: {
              models: {
                "gpt-5.4-pro": {
                  cost: { input: 999, output: 180 },
                },
              },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("OPENAI_API_KEY", "test-openai-key")
    },
    fn: async () => {
      const model = (await Provider.list()).openai.models["gpt-5.4-pro"]
      expect(model.cost.input).toBe(999)
      expect(Object.keys(model.variants ?? {})).toEqual(["medium", "high", "xhigh"])
    },
  })
})

test("disabled_providers and enabled_providers interaction", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          // enabled_providers takes precedence - only these are considered
          enabled_providers: ["anthropic", "openai"],
          // Then disabled_providers filters from the enabled set
          disabled_providers: ["openai"],
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-anthropic")
      Env.set("OPENAI_API_KEY", "test-openai")
      Env.set("GOOGLE_GENERATIVE_AI_API_KEY", "test-google")
    },
    fn: async () => {
      const providers = await Provider.list()
      // anthropic: in enabled, not in disabled = allowed
      expect(providers["anthropic"]).toBeDefined()
      // openai: in enabled, but also in disabled = NOT allowed
      expect(providers["openai"]).toBeUndefined()
      // google: not in enabled = NOT allowed (even though not disabled)
      expect(providers["google"]).toBeUndefined()
    },
  })
})

test("model with tool_call false", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            "no-tools": {
              name: "No Tools Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "basic-model": {
                  name: "Basic Model",
                  tool_call: false,
                  limit: { context: 4000, output: 1000 },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["no-tools"].models["basic-model"].capabilities.toolcall).toBe(false)
    },
  })
})

test("model defaults tool_call to true when not specified", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            "default-tools": {
              name: "Default Tools Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                model: {
                  name: "Model",
                  // tool_call not specified
                  limit: { context: 4000, output: 1000 },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["default-tools"].models["model"].capabilities.toolcall).toBe(true)
    },
  })
})

test("model headers are preserved", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            "headers-provider": {
              name: "Headers Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                model: {
                  name: "Model",
                  tool_call: true,
                  limit: { context: 4000, output: 1000 },
                  headers: {
                    "X-Custom-Header": "custom-value",
                    Authorization: "Bearer special-token",
                  },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["headers-provider"].models["model"]
      expect(model.headers).toEqual({
        "X-Custom-Header": "custom-value",
        Authorization: "Bearer special-token",
      })
    },
  })
})

test("provider env fallback - second env var used if first missing", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            "fallback-env": {
              name: "Fallback Env Provider",
              npm: "@ai-sdk/openai-compatible",
              env: ["PRIMARY_KEY", "FALLBACK_KEY"],
              models: {
                model: {
                  name: "Model",
                  tool_call: true,
                  limit: { context: 4000, output: 1000 },
                },
              },
              options: { baseURL: "https://api.example.com" },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      // Only set fallback, not primary
      Env.set("FALLBACK_KEY", "fallback-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      // Provider should load because fallback env var is set
      expect(providers["fallback-env"]).toBeDefined()
    },
  })
})

test("getModel returns consistent results", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const model1 = await Provider.getModel("anthropic", "claude-sonnet-4-5")
      const model2 = await Provider.getModel("anthropic", "claude-sonnet-4-5")
      expect(model1.providerID).toEqual(model2.providerID)
      expect(model1.id).toEqual(model2.id)
      expect(model1).toEqual(model2)
    },
  })
})

test("provider name defaults to id when not in database", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            "my-custom-id": {
              // no name specified
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                model: {
                  name: "Model",
                  tool_call: true,
                  limit: { context: 4000, output: 1000 },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["my-custom-id"].name).toBe("my-custom-id")
    },
  })
})

test("ModelNotFoundError includes suggestions for typos", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      try {
        await Provider.getModel("anthropic", "claude-sonet-4") // typo: sonet instead of sonnet
        expect(true).toBe(false) // Should not reach here
      } catch (e: any) {
        expect(e.data.suggestions).toBeDefined()
        expect(e.data.suggestions.length).toBeGreaterThan(0)
      }
    },
  })
})

test("ModelNotFoundError for provider includes suggestions", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      try {
        await Provider.getModel("antropic", "claude-sonnet-4") // typo: antropic
        expect(true).toBe(false) // Should not reach here
      } catch (e: any) {
        expect(e.data.suggestions).toBeDefined()
        expect(e.data.suggestions).toContain("anthropic")
      }
    },
  })
})

test("getProvider returns undefined for nonexistent provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    fn: async () => {
      const provider = await Provider.getProvider("nonexistent")
      expect(provider).toBeUndefined()
    },
  })
})

test("getProvider returns provider info", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const provider = await Provider.getProvider("anthropic")
      expect(provider).toBeDefined()
      expect(provider?.id).toBe("anthropic")
    },
  })
})

test("model limit defaults to zero when not specified", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            "no-limit": {
              name: "No Limit Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                model: {
                  name: "Model",
                  tool_call: true,
                  // no limit specified
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["no-limit"].models["model"]
      expect(model.limit.context).toBe(0)
      expect(model.limit.output).toBe(0)
    },
  })
})

test("provider options are deeply merged", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            anthropic: {
              options: {
                headers: {
                  "X-Custom": "custom-value",
                },
                timeout: 30000,
              },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      // Custom options should be merged
      expect(providers["anthropic"].options.timeout).toBe(30000)
      expect(providers["anthropic"].options.headers["X-Custom"]).toBe("custom-value")
      // anthropic custom loader adds its own headers, they should coexist
      expect(providers["anthropic"].options.headers["anthropic-beta"]).toBeDefined()
    },
  })
})

test("openrouter provider adds attribution headers and merges custom headers", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            openrouter: {
              options: {
                headers: {
                  "X-Custom": "custom-value",
                },
              },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("OPENROUTER_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["openrouter"].options.headers).toMatchObject({
        "HTTP-Referer": "https://synergy.holosai.io/",
        "X-OpenRouter-Title": "Synergy",
        "X-OpenRouter-Categories": "cli-agent,personal-agent",
        "X-Custom": "custom-value",
      })
    },
  })
})

test("custom model inherits npm package from models.dev provider config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            openai: {
              models: {
                "my-custom-model": {
                  name: "My Custom Model",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("OPENAI_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["openai"].models["my-custom-model"]
      expect(model).toBeDefined()
      expect(model.api.npm).toBe("@ai-sdk/openai")
    },
  })
})

test("custom model inherits api.url from models.dev provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            openrouter: {
              models: {
                "prime-intellect/intellect-3": {},
                "deepseek/deepseek-r1-0528": {
                  name: "DeepSeek R1",
                },
              },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("OPENROUTER_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["openrouter"]).toBeDefined()

      // New model not in database should inherit api.url from provider
      const intellect = providers["openrouter"].models["prime-intellect/intellect-3"]
      expect(intellect).toBeDefined()
      expect(intellect.api.url).toBe("https://openrouter.ai/api/v1")

      // Another new model should also inherit api.url
      const deepseek = providers["openrouter"].models["deepseek/deepseek-r1-0528"]
      expect(deepseek).toBeDefined()
      expect(deepseek.api.url).toBe("https://openrouter.ai/api/v1")
      expect(deepseek.name).toBe("DeepSeek R1")
    },
  })
})

test("model variants are generated for reasoning models", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      // Claude sonnet 4 has reasoning capability
      const model = providers["anthropic"].models["claude-sonnet-4-5"]
      expect(model.capabilities.reasoning).toBe(true)
      expect(model.variants).toBeDefined()
      expect(Object.keys(model.variants!).length).toBeGreaterThan(0)
    },
  })
})

test("Kimi K2 config variants remain explicit without generated Anthropic variants", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            "kimi-for-coding": {
              models: {
                "kimi-k2-thinking": {
                  variants: {
                    custom: {
                      customField: "configured",
                    },
                    removed: {
                      customField: "disabled",
                      disabled: true,
                    },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("KIMI_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["kimi-for-coding"].models["kimi-k2-thinking"]
      expect(Object.keys(model.variants ?? {})).toEqual(["custom"])
      expect(model.variants?.custom).toEqual({ customField: "configured" })
    },
  })
})

test("model variants can be disabled via config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-5": {
                  variants: {
                    high: { disabled: true },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["anthropic"].models["claude-sonnet-4-5"]
      expect(model.variants).toBeDefined()
      expect(model.variants!["high"]).toBeUndefined()
      // max variant should still exist
      expect(model.variants!["max"]).toBeDefined()
    },
  })
})

test("model variants can be customized via config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-5": {
                  variants: {
                    high: {
                      thinking: {
                        type: "enabled",
                        budgetTokens: 20000,
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["anthropic"].models["claude-sonnet-4-5"]
      expect(model.variants!["high"]).toBeDefined()
      expect(model.variants!["high"].thinking.budgetTokens).toBe(20000)
    },
  })
})

test("disabled key is stripped from variant config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-5": {
                  variants: {
                    max: {
                      disabled: false,
                      customField: "test",
                    },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["anthropic"].models["claude-sonnet-4-5"]
      expect(model.variants!["max"]).toBeDefined()
      expect(model.variants!["max"].disabled).toBeUndefined()
      expect(model.variants!["max"].customField).toBe("test")
    },
  })
})

test("all variants can be disabled via config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-5": {
                  variants: {
                    high: { disabled: true },
                    max: { disabled: true },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["anthropic"].models["claude-sonnet-4-5"]
      expect(model.variants).toBeDefined()
      expect(Object.keys(model.variants!).length).toBe(0)
    },
  })
})

test("variant config merges with generated variants", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-5": {
                  variants: {
                    high: {
                      extraOption: "custom-value",
                    },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["anthropic"].models["claude-sonnet-4-5"]
      expect(model.variants!["high"]).toBeDefined()
      // Should have both the generated thinking config and the custom option
      expect(model.variants!["high"].thinking).toBeDefined()
      expect(model.variants!["high"].extraOption).toBe("custom-value")
    },
  })
})

test("variants filtered in second pass for database models", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            openai: {
              models: {
                "gpt-5": {
                  variants: {
                    high: { disabled: true },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    init: async () => {
      Env.set("OPENAI_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["openai"].models["gpt-5"]
      expect(model.variants).toBeDefined()
      expect(model.variants!["high"]).toBeUndefined()
      // Other variants should still exist
      expect(model.variants!["medium"]).toBeDefined()
    },
  })
})

test("custom model with variants enabled and disabled", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            "custom-reasoning": {
              name: "Custom Reasoning Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "reasoning-model": {
                  name: "Reasoning Model",
                  tool_call: true,
                  reasoning: true,
                  limit: { context: 128000, output: 16000 },
                  variants: {
                    low: { reasoningEffort: "low" },
                    medium: { reasoningEffort: "medium" },
                    high: { reasoningEffort: "high", disabled: true },
                    custom: { reasoningEffort: "custom", budgetTokens: 5000 },
                  },
                },
              },
              options: { apiKey: "test-key" },
            },
          },
        }),
      )
    },
  })
  await provideTestScope({
    scope: await tmp.scope(),
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["custom-reasoning"].models["reasoning-model"]
      expect(model.variants).toBeDefined()
      // Enabled variants should exist
      expect(model.variants!["low"]).toBeDefined()
      expect(model.variants!["low"].reasoningEffort).toBe("low")
      expect(model.variants!["medium"]).toBeDefined()
      expect(model.variants!["medium"].reasoningEffort).toBe("medium")
      expect(model.variants!["custom"]).toBeDefined()
      expect(model.variants!["custom"].reasoningEffort).toBe("custom")
      expect(model.variants!["custom"].budgetTokens).toBe(5000)
      // Disabled variant should not exist
      expect(model.variants!["high"]).toBeUndefined()
      // disabled key should be stripped from all variants
      expect(model.variants!["low"].disabled).toBeUndefined()
      expect(model.variants!["medium"].disabled).toBeUndefined()
      expect(model.variants!["custom"].disabled).toBeUndefined()
    },
  })
})
