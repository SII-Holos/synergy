import { describe, expect, test } from "bun:test"
import type { Provider } from "../../src/provider/provider"
import { ScopeContext } from "../../src/scope/context"
import { LLM } from "../../src/session/llm"
import { tmpdir } from "../fixture/fixture"

function model(): Provider.Model {
  return {
    id: "variant-model",
    providerID: "variant-provider",
    name: "Variant Model",
    family: "variant-model",
    api: { id: "variant-model", url: "https://example.invalid", npm: "@ai-sdk/openai" },
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 100_000, output: 8_192 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
    variants: {
      high: { rootVariantMarker: "high" },
      max: { rootVariantMarker: "max" },
    },
  }
}

function input(userVariant?: string, small = false): LLM.StreamInput {
  return {
    user: {
      id: "msg_root_variant",
      sessionID: "ses_root_variant",
      role: "user",
      time: { created: Date.now() },
      agent: "variant-agent",
      model: { providerID: "variant-provider", modelID: "variant-model" },
      isRoot: true,
      rootID: "msg_root_variant",
      origin: { type: "user" },
      variant: userVariant,
    },
    sessionID: "ses_root_variant",
    model: model(),
    agent: {
      name: "variant-agent",
      mode: "primary",
      permission: [],
      options: {},
      defaultVariant: "max",
    },
    system: [],
    abort: new AbortController().signal,
    messages: [],
    tools: {},
    small,
  } as LLM.StreamInput
}

describe("LLM root variant consumption", () => {
  test("does not re-run agent defaults when the persisted root has no variant", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const prepared = await LLM.prepare(input())
        expect(prepared.params.options.rootVariantMarker).toBeUndefined()
      },
    })
  })

  test("fails explicitly when the persisted root variant is unavailable", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await expect(LLM.prepare(input("missing"))).rejects.toMatchObject({
          name: "ProviderModelVariantUnavailableError",
          data: {
            providerID: "variant-provider",
            modelID: "variant-model",
            variant: "missing",
            availableVariants: ["high", "max"],
          },
        })
      },
    })
  })

  test("bypasses variant validation and options for small calls even when the persisted variant is unavailable", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const prepared = await LLM.prepare(input("missing", true))
        expect(prepared.params.options.rootVariantMarker).toBeUndefined()
      },
    })
  })

  test("bypasses variant options for small calls when the persisted variant is valid", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const prepared = await LLM.prepare(input("high", true))
        expect(prepared.params.options.rootVariantMarker).toBeUndefined()
      },
    })
  })

  test("applies variant options for a valid persisted variant on a non-small root", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const prepared = await LLM.prepare(input("high"))
        expect(prepared.params.options.rootVariantMarker).toBe("high")
      },
    })
  })
})
