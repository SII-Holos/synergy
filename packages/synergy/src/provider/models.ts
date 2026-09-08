import { z } from "zod"
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

  export type RefreshResult =
    | { status: "refreshed"; rejectedProviders: number; rejectedModels: number }
    | { status: "failed" }
    | { status: "disabled" }

  let inFlight: Promise<RefreshResult> | undefined
  let cache: Catalog | null = null
  const refreshListeners = new Set<() => void | Promise<void>>()

  export function onRefresh(listener: () => void | Promise<void>) {
    refreshListeners.add(listener)
    return () => refreshListeners.delete(listener)
  }

  async function notifyRefresh() {
    await Promise.all([...refreshListeners].map((listener) => listener()))
  }

  const CatalogEnvelope = z.record(z.string(), z.unknown())

  function parseCatalog(input: unknown) {
    const envelope = CatalogEnvelope.safeParse(input)
    if (!envelope.success) return
    const ProviderEnvelope = ModelsDevCatalog.valueType.extend({ models: z.record(z.string(), z.unknown()) })
    const ModelSchema = ModelsDevCatalog.valueType.shape.models.valueType
    const catalog: Catalog = {}
    let rejectedProviders = 0
    let rejectedModels = 0
    for (const [providerID, input] of Object.entries(envelope.data)) {
      const provider = ProviderEnvelope.safeParse(input)
      if (!provider.success) {
        rejectedProviders++
        continue
      }
      const models: Record<string, Model> = {}
      for (const [modelID, input] of Object.entries(provider.data.models)) {
        const model = ModelSchema.safeParse(input)
        if (model.success) models[modelID] = model.data
        else rejectedModels++
      }
      catalog[providerID] = { ...provider.data, models }
    }
    if (missingRequiredModelsDevProviders(catalog).length > 0) return
    if (rejectedProviders || rejectedModels) {
      log.warn("ignored malformed models catalog entries", { rejectedProviders, rejectedModels })
    }
    return { catalog, rejectedProviders, rejectedModels }
  }

  function parseCatalogText(input: string) {
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
      cache = stored.catalog
      refreshInBackground()
      return cache
    }

    const bundledText = typeof data === "function" ? "{}" : await (data as unknown as () => Promise<string>)()
    const bundled = parseCatalogText(bundledText)
    if (!bundled) log.warn("ignored invalid bundled models catalog")
    cache = bundled?.catalog ?? {}
    refreshInBackground()
    return cache
  }

  export function refresh(): Promise<RefreshResult> {
    if (Flag.SYNERGY_DISABLE_MODELS_FETCH) return Promise.resolve({ status: "disabled" })
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

  async function doRefresh(): Promise<RefreshResult> {
    const file = Bun.file(filepath)
    log.info("refreshing", { file })
    for (const url of MIRRORS) {
      const result = await fetch(url, {
        headers: { "User-Agent": Installation.USER_AGENT },
        signal: AbortSignal.timeout(10 * 1000),
      }).catch((error) => {
        log.warn("failed to fetch models catalog", { url, error })
      })
      if (!result) continue
      if (!result.ok) {
        log.warn("models catalog refresh returned non-success status", { url, status: result.status })
        continue
      }
      const text = await result.text().catch((error) => {
        log.warn("failed to read models catalog", { url, error })
      })
      const parsed = text ? parseCatalogText(text) : undefined
      if (!parsed) {
        log.warn("ignored invalid refreshed models catalog", { url })
        continue
      }
      await Bun.write(file, JSON.stringify(parsed.catalog))
      cache = parsed.catalog
      await notifyRefresh()
      return { status: "refreshed", rejectedProviders: parsed.rejectedProviders, rejectedModels: parsed.rejectedModels }
    }
    return { status: "failed" }
  }
}

setInterval(() => ModelsDev.refresh(), 60 * 1000 * 60).unref()
