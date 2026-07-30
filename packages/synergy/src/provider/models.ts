import { Global } from "../global"
import { Log } from "../util/log"
import { ModelsDev as ModelsDevSchemas } from "./models-schemas"
import { data } from "./models-macro" with { type: "macro" }
import { Installation } from "../global/installation"
import { Flag } from "../flag/flag"

export namespace ModelsDev {
  const log = Log.create({ service: "models.dev" })
  const filepath = Global.Path.modelsCache

  export const ReasoningOption = ModelsDevSchemas.ReasoningOption
  export type ReasoningOption = ModelsDevSchemas.ReasoningOption

  export const Model = ModelsDevSchemas.Model
  export type Model = ModelsDevSchemas.Model

  export const reasoningEfforts = ModelsDevSchemas.reasoningEfforts

  export const Provider = ModelsDevSchemas.Provider
  export type Provider = ModelsDevSchemas.Provider

  let inFlight: Promise<void> | undefined
  let cache: Record<string, any> | null = null

  export async function get() {
    if (cache) return cache
    refresh()
    const file = Bun.file(filepath)
    const result = await file.json().catch(() => {})
    if (result) {
      cache = result as Record<string, Provider>
      return cache
    }
    const json =
      typeof data === "function" ? await data() : await fetch("https://models.dev/api.json").then((x) => x.text())
    const parsed = JSON.parse(json) as Record<string, Provider>
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
        cache = JSON.parse(text) as Record<string, Provider>
      } catch {
        // leave stale cache on parse failure
      }
    }
  }
}

setInterval(() => ModelsDev.refresh(), 60 * 1000 * 60).unref()
