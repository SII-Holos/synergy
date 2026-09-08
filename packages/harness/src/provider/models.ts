import { Global } from "../global"
import { Log } from "../util/log"
import { ModelsDev as ModelsDevSchemas, ModelsDevCatalog, missingRequiredModelsDevProviders } from "./models-schemas"
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

  type Catalog = ModelsDevCatalog

  let inFlight: Promise<void> | undefined
  let cache: Catalog | null = null
  const refreshListeners = new Set<() => void | Promise<void>>()

  export function onRefresh(listener: () => void | Promise<void>) {
    refreshListeners.add(listener)
    return () => refreshListeners.delete(listener)
  }

  async function notifyRefresh() {
    await Promise.all([...refreshListeners].map((listener) => listener()))
  }

  function parseCatalog(input: unknown): Catalog | undefined {
    const parsed = ModelsDevCatalog.safeParse(input)
    if (!parsed.success) return
    return missingRequiredModelsDevProviders(parsed.data).length === 0 ? parsed.data : undefined
  }

  function parseCatalogText(input: string): Catalog | undefined {
    try {
      return parseCatalog(JSON.parse(input))
    } catch {
      return
    }
  }

  function refreshInBackground() {
    void refresh()?.catch((error) => {
      log.warn("failed to persist refreshed models catalog", { error })
    })
  }

  export async function get() {
    if (cache) return cache

    const file = Bun.file(filepath)
    const stored = parseCatalog(await file.json().catch(() => undefined))
    if (stored) {
      cache = stored
      refreshInBackground()
      return cache
    }

    const bundledText = typeof data === "function" ? "{}" : await (data as unknown as () => Promise<string>)()
    const bundled = parseCatalogText(bundledText)
    if (!bundled) log.warn("ignored invalid bundled models catalog")
    cache = bundled ?? {}
    refreshInBackground()
    return cache
  }

  export function refresh(): Promise<void> | undefined {
    if (Flag.SYNERGY_DISABLE_MODELS_FETCH) return
    if (inFlight) return inFlight
    inFlight = doRefresh().finally(() => {
      inFlight = undefined
    })
    return inFlight
  }

  const MIRRORS = [
    "https://models.dev/api.json",
    "https://raw.githubusercontent.com/SII-Holos/synergy-provider-registry/main/models.json",
  ] as const

  async function doRefresh() {
    const file = Bun.file(filepath)
    log.info("refreshing", { file })
    let text: string | undefined
    for (const url of MIRRORS) {
      const result = await fetch(url, {
        headers: {
          "User-Agent": Installation.USER_AGENT,
        },
        signal: AbortSignal.timeout(10 * 1000),
      }).catch((error) => {
        log.warn("failed to fetch models catalog", { url, error })
      })
      if (!result) continue
      if (!result.ok) {
        log.warn("models catalog refresh returned non-success status", { url, status: result.status })
        continue
      }
      const candidate = await result.text()
      if (!parseCatalogText(candidate)) {
        log.warn("ignored invalid refreshed models catalog", { url })
        continue
      }
      text = candidate
      break
    }
    if (!text) return

    const parsed = parseCatalogText(text)
    if (!parsed) return

    await Bun.write(file, text)
    cache = parsed
    await notifyRefresh()
  }
}

setInterval(() => ModelsDev.refresh(), 60 * 1000 * 60).unref()
