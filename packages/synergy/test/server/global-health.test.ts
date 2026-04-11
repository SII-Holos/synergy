import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import fs from "fs/promises"
import path from "path"

mock.module("../../src/util/bun", () => ({
  BunProc: {
    install: async (pkg: string) => pkg,
    run: async () => {},
    which: () => process.execPath,
    InstallFailedError: class extends Error {},
  },
}))

mock.module("../../src/provider/models", async () => {
  const z = (await import("zod")).default

  const Model = z.object({
    id: z.string(),
    name: z.string(),
    family: z.string().optional(),
    release_date: z.string(),
    attachment: z.boolean(),
    reasoning: z.boolean(),
    temperature: z.boolean(),
    tool_call: z.boolean(),
    interleaved: z.any().optional(),
    cost: z
      .object({
        input: z.number(),
        output: z.number(),
        cache_read: z.number().optional(),
        cache_write: z.number().optional(),
        context_over_200k: z
          .object({
            input: z.number(),
            output: z.number(),
            cache_read: z.number().optional(),
            cache_write: z.number().optional(),
          })
          .optional(),
      })
      .optional(),
    limit: z.object({
      context: z.number(),
      output: z.number(),
    }),
    modalities: z
      .object({
        input: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
        output: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
      })
      .optional(),
    experimental: z.boolean().optional(),
    status: z.enum(["alpha", "beta", "deprecated"]).optional(),
    options: z.record(z.string(), z.any()),
    headers: z.record(z.string(), z.string()).optional(),
    provider: z.object({ npm: z.string() }).optional(),
    variants: z.record(z.string(), z.record(z.string(), z.any())).optional(),
  })

  const Provider = z.object({
    api: z.string().optional(),
    name: z.string(),
    env: z.array(z.string()),
    id: z.string(),
    npm: z.string().optional(),
    models: z.record(z.string(), Model),
  })

  return {
    ModelsDev: {
      Model,
      Provider,
      refresh: async () => {},
      get: async () => ({
        openai: {
          id: "openai",
          name: "OpenAI",
          env: ["OPENAI_API_KEY"],
          npm: "@ai-sdk/openai",
          api: "https://api.openai.com/v1",
          models: {
            "gpt-4.1-mini": {
              id: "gpt-4.1-mini",
              name: "GPT-4.1 mini",
              family: "OpenAI",
              release_date: "2025-04-01",
              attachment: true,
              reasoning: false,
              temperature: true,
              tool_call: true,
              limit: {
                context: 128000,
                output: 16384,
              },
              modalities: {
                input: ["text", "image"],
                output: ["text"],
              },
              options: {},
            },
          },
        },
      }),
    },
  }
})

const { tmpdir } = await import("../fixture/fixture")
const { ConfigSet } = await import("../../src/config/set")
const { Global } = await import("../../src/global")
const { Auth } = await import("../../src/provider/api-key")
const { Server } = await import("../../src/server/server")
const { Instance } = await import("../../src/scope/instance")
const { Log } = await import("../../src/util/log")

Log.init({ print: false })

const providerEnvKeys = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_BEARER_TOKEN_BEDROCK",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "PERPLEXITY_API_KEY",
  "TOGETHER_API_KEY",
  "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "FIREWORKS_API_KEY",
  "CEREBRAS_API_KEY",
  "SAMBANOVA_API_KEY",
]

let authBackup: string | undefined
let configBackup: string | undefined
let configPath = ""
let envBackup: Record<string, string | undefined> = {}

async function readOptional(filepath: string) {
  return Bun.file(filepath)
    .text()
    .then((value) => value)
    .catch(() => undefined)
}

async function restoreFile(filepath: string, contents: string | undefined) {
  if (contents === undefined) {
    await fs.rm(filepath, { force: true })
    return
  }
  await fs.mkdir(path.dirname(filepath), { recursive: true })
  await Bun.write(filepath, contents)
}

describe("global health scoping", () => {
  beforeEach(async () => {
    configPath = ConfigSet.filePath(ConfigSet.activeNameSync())
    authBackup = await readOptional(Global.Path.authApiKey)
    configBackup = await readOptional(configPath)
    envBackup = Object.fromEntries(providerEnvKeys.map((key) => [key, process.env[key]]))

    for (const key of providerEnvKeys) {
      delete process.env[key]
    }

    await fs.mkdir(path.dirname(Global.Path.authApiKey), { recursive: true })
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await Bun.write(Global.Path.authApiKey, "{}\n")
    await Bun.write(configPath, "{}\n")
    await Instance.disposeAll()
  })

  afterEach(async () => {
    await restoreFile(Global.Path.authApiKey, authBackup)
    await restoreFile(configPath, configBackup)

    for (const key of providerEnvKeys) {
      const value = envBackup[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }

    await Instance.disposeAll()
  })

  test("reports modelReady false when no providers are configured", async () => {
    const app = Server.App()
    const response = await app.request("/global/health")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(
      expect.objectContaining({
        healthy: true,
        modelReady: false,
      }),
    )
  })

  test("uses the global instance for health checks and matches config provider readiness", async () => {
    await Auth.set("openai", { type: "api", key: "test-openai-key" })
    await Instance.disposeAll()

    const app = Server.App()
    const [healthResponse, providersResponse] = await Promise.all([
      app.request("/global/health"),
      app.request("/config/providers?directory=global"),
    ])

    expect(healthResponse.status).toBe(200)
    expect(providersResponse.status).toBe(200)

    const health = await healthResponse.json()
    const providers = (await providersResponse.json()) as {
      providers: Array<{ id: string }>
      default: Record<string, string>
    }

    expect(health).toEqual(
      expect.objectContaining({
        healthy: true,
        modelReady: true,
      }),
    )
    expect(providers.providers.length).toBeGreaterThan(0)
    expect(providers.providers.some((provider) => provider.id === "openai")).toBe(true)
    expect(providers.default["openai"]).toBeTruthy()
  })

  test("keeps global routes on global scope even when a project directory is supplied", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "synergy.json"),
          JSON.stringify({
            disabled_providers: ["openai"],
          }),
        )
      },
    })

    await Auth.set("openai", { type: "api", key: "test-openai-key" })
    await Instance.disposeAll()

    const directory = encodeURIComponent(tmp.path)
    const app = Server.App()
    const [healthResponse, projectProvidersResponse] = await Promise.all([
      app.request(`/global/health?directory=${directory}`),
      app.request(`/config/providers?directory=${directory}`),
    ])

    expect(healthResponse.status).toBe(200)
    expect(projectProvidersResponse.status).toBe(200)

    const health = await healthResponse.json()
    const projectProviders = (await projectProvidersResponse.json()) as {
      providers: Array<{ id: string }>
    }

    expect(health).toEqual(
      expect.objectContaining({
        healthy: true,
        modelReady: true,
      }),
    )
    expect(projectProviders.providers.some((provider) => provider.id === "openai")).toBe(false)
  })
})
