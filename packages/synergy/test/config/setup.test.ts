import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/scope/instance"

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
        "minimax-cn-coding-plan": {
          id: "minimax-cn-coding-plan",
          name: "MiniMax Coding Plan",
          env: ["MINIMAX_API_KEY"],
          npm: "@ai-sdk/anthropic",
          api: "https://api.minimaxi.com/anthropic/v1",
          models: {
            "MiniMax-M2.7": {
              id: "MiniMax-M2.7",
              name: "MiniMax-M2.7",
              family: "minimax",
              release_date: "2026-03-18",
              attachment: false,
              reasoning: true,
              temperature: true,
              tool_call: true,
              limit: {
                context: 204800,
                output: 131072,
              },
              modalities: {
                input: ["text"],
                output: ["text"],
              },
              cost: {
                input: 0,
                output: 0,
              },
              options: {},
            },
          },
        },
      }),
    },
  }
})

const { ConfigSetup } = await import("../../src/config/setup")
const { Auth } = await import("../../src/provider/api-key")
const { ConfigSet } = await import("../../src/config/set")
const { Global } = await import("../../src/global")

const validRequiredCoreValidation = {
  valid: true,
  fields: {
    model: { valid: true, message: "ok", mode: "static" as const },
    vision_model: { valid: true, message: "ok", mode: "static" as const },
    embedding: { valid: true, message: "ok", mode: "static" as const },
    rerank: { valid: true, message: "ok", mode: "static" as const },
  },
}

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
  const directory = filepath.slice(0, filepath.lastIndexOf("/"))
  await fs.mkdir(directory, { recursive: true })
  await Bun.write(filepath, contents)
}

describe("ConfigSetup required core validation", () => {
  let authBackup: string | undefined
  let metadataBackup: string | undefined
  let defaultConfigBackup: string | undefined
  let customSetBackup: string | undefined

  beforeEach(async () => {
    authBackup = await readOptional(Global.Path.authApiKey)
    metadataBackup = await readOptional(ConfigSet.metadataPath())
    defaultConfigBackup = await readOptional(ConfigSet.defaultFilePath())
    customSetBackup = await readOptional(ConfigSet.filePath("test-set"))
    await Auth.remove("minimax-cn-coding-plan")
    await fs.mkdir(ConfigSet.configDirectory("test-set"), { recursive: true }).catch(() => {})
  })

  afterEach(async () => {
    await Auth.remove("minimax-cn-coding-plan")
    delete process.env.MINIMAX_API_KEY
    await restoreFile(Global.Path.authApiKey, authBackup)
    await restoreFile(ConfigSet.metadataPath(), metadataBackup)
    await restoreFile(ConfigSet.defaultFilePath(), defaultConfigBackup)
    await restoreFile(ConfigSet.filePath("test-set"), customSetBackup)
    if (customSetBackup === undefined) {
      await fs.rm(ConfigSet.configDirectory("test-set"), { recursive: true, force: true })
    }
    await Instance.disposeAll()
  })

  test("validates a catalog model using setup draft context even when runtime provider is inactive", async () => {
    const draft = {
      model: "minimax-cn-coding-plan/MiniMax-M2.7",
      vision_model: "minimax-cn-coding-plan/MiniMax-M2.7",
      auth: {
        "minimax-cn-coding-plan": {
          mode: "set" as const,
          key: "test-minimax-key",
        },
      },
    }

    const validation = await ConfigSetup.validateRequiredCore(draft)
    expect(validation.fields.model.valid).toBe(true)
    expect(validation.fields.model.message).toBe("Default model verified")
    expect(validation.fields.vision_model.valid).toBe(false)
    expect(validation.fields.vision_model.message).toBe("Vision model must support image, PDF, or video input")
  })

  test("finalizeConfig writes config to default config set when no custom set is active", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const draft = {
          model: "minimax-cn-coding-plan/MiniMax-M2.7",
          vision_model: "minimax-cn-coding-plan/MiniMax-M2.7",
          auth: {
            "minimax-cn-coding-plan": {
              mode: "set" as const,
              key: "test-minimax-key",
            },
          },
        }

        const activeSetBefore = await ConfigSet.activeName()
        expect(activeSetBefore).toBe("default")

        const result = await ConfigSetup.finalizeConfig(draft, validRequiredCoreValidation)

        const activeSetAfter = await ConfigSet.activeName()
        expect(activeSetAfter).toBe("default")

        const writtenContent = await Bun.file(result.filepath).text()
        const writtenConfig = JSON.parse(writtenContent)
        expect(writtenConfig.model).toBe("minimax-cn-coding-plan/MiniMax-M2.7")
        expect(writtenConfig.vision_model).toBe("minimax-cn-coding-plan/MiniMax-M2.7")
      },
    })
  })

  test("finalizeConfig writes config to active config set when custom set is active", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await ConfigSet.create("test-set")
        await ConfigSet.activate("test-set")

        const draft = {
          model: "minimax-cn-coding-plan/MiniMax-M2.7",
          vision_model: "minimax-cn-coding-plan/MiniMax-M2.7",
          auth: {
            "minimax-cn-coding-plan": {
              mode: "set" as const,
              key: "test-minimax-key",
            },
          },
        }

        const activeSetBefore = await ConfigSet.activeName()
        expect(activeSetBefore).toBe("test-set")

        const result = await ConfigSetup.finalizeConfig(draft, validRequiredCoreValidation)

        const activeSetAfter = await ConfigSet.activeName()
        expect(activeSetAfter).toBe("test-set")
        expect(result.filepath.includes("test-set")).toBe(true)

        const writtenContent = await Bun.file(result.filepath).text()
        const writtenConfig = JSON.parse(writtenContent)
        expect(writtenConfig.model).toBe("minimax-cn-coding-plan/MiniMax-M2.7")
        expect(writtenConfig.vision_model).toBe("minimax-cn-coding-plan/MiniMax-M2.7")
      },
    })
  })
})
