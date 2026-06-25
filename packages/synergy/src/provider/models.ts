import { Global } from "../global"
import { Log } from "../util/log"
import z from "zod"
import { data } from "./models-macro" with { type: "macro" }
import { Installation } from "../global/installation"
import { Flag } from "../flag/flag"
import { CodexProvider } from "./codex"

export namespace ModelsDev {
  const log = Log.create({ service: "models.dev" })
  const filepath = Global.Path.modelsCache

  export const Model = z.object({
    id: z.string(),
    name: z.string(),
    family: z.string().optional(),
    release_date: z.string(),
    attachment: z.boolean(),
    reasoning: z.boolean(),
    temperature: z.boolean(),
    tool_call: z.boolean(),
    interleaved: z
      .union([
        z.literal(true),
        z
          .object({
            field: z.enum(["reasoning_content", "reasoning_details"]),
          })
          .strict(),
      ])
      .optional(),
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
      input: z.number().optional(),
      output: z.number(),
    }),
    modalities: z
      .object({
        input: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
        output: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
      })
      .optional(),
    status: z.enum(["alpha", "beta", "deprecated"]).optional(),
    options: z.record(z.string(), z.any()),
    headers: z.record(z.string(), z.string()).optional(),
    provider: z.object({ npm: z.string() }).optional(),
    variants: z.record(z.string(), z.record(z.string(), z.any())).optional(),
  })
  export type Model = z.infer<typeof Model>

  export const Provider = z.object({
    api: z.string().optional(),
    name: z.string(),
    env: z.array(z.string()),
    id: z.string(),
    npm: z.string().optional(),
    models: z.record(z.string(), Model),
  })

  export type Provider = z.infer<typeof Provider>

  let inFlight: Promise<void> | undefined
  let cache: Record<string, any> | null = null

  function withBuiltinProviders(input: Record<string, Provider>): Record<string, Provider> {
    return {
      ...input,
      [CodexProvider.PROVIDER_ID]: CodexProvider.modelsDevProvider(
        CodexProvider.DEFAULT_MODEL_IDS,
        input.openai?.models,
      ),
    }
  }

  export async function get() {
    if (cache) return cache
    refresh()
    const file = Bun.file(filepath)
    const result = await file.json().catch(() => {})
    if (result) {
      cache = withBuiltinProviders(result as Record<string, Provider>)
      return cache
    }
    const json =
      typeof data === "function" ? await data() : await fetch("https://models.dev/api.json").then((x) => x.text())
    const parsed = withBuiltinProviders(JSON.parse(json) as Record<string, Provider>)
    cache = parsed
    return parsed
  }

  export function refresh(): Promise<void> | undefined {
    if (Flag.SYNERGY_DISABLE_MODELS_FETCH) return
    if (inFlight) return inFlight
    inFlight = doRefresh().finally(() => {
      inFlight = undefined
    })
    return inFlight
  }

  async function doRefresh() {
    const file = Bun.file(filepath)
    log.info("refreshing", {
      file,
    })
    const result = await fetch("https://models.dev/api.json", {
      headers: {
        "User-Agent": Installation.USER_AGENT,
      },
      signal: AbortSignal.timeout(10 * 1000),
    }).catch((e) => {
      log.error("Failed to fetch models.dev", {
        error: e,
      })
    })
    if (result && result.ok) {
      const text = await result.text()
      await Bun.write(file, text)
      try {
        cache = withBuiltinProviders(JSON.parse(text) as Record<string, Provider>)
      } catch {
        // leave stale cache on parse failure
      }
    }
  }
}

setInterval(() => ModelsDev.refresh(), 60 * 1000 * 60).unref()
