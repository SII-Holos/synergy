import { RuntimeContext } from "../lifecycle/context"
import { z } from "zod"
import { Global } from "../global"
import { Log } from "../util/log"
import { ModelsDev as ModelsDevSchemas, ModelsDevCatalog, missingRequiredModelsDevProviders } from "./models-schemas"
import { data } from "./models-macro" with { type: "macro" }
import { Installation } from "../global/installation"
import { Flag } from "../flag/flag"

export namespace ModelsCatalog {
  const log = Log.create({ service: "models.dev" })

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

  const runtimeState = RuntimeContext.state(() => ({
    shutdown: new AbortController(),
    inFlight: undefined as Promise<RefreshResult> | undefined,
    cache: null as Catalog | null,
    refreshListeners: new Set<() => void | Promise<void>>(),
  }))

  export function onRefresh(listener: () => void | Promise<void>) {
    const instanceState = runtimeState()

    instanceState.refreshListeners.add(listener)
    return () => instanceState.refreshListeners.delete(listener)
  }

  async function notifyRefresh() {
    const instanceState = runtimeState()

    await Promise.all([...instanceState.refreshListeners].map((listener) => listener()))
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
    const instanceState = runtimeState()

    if (instanceState.cache) return instanceState.cache

    const file = Bun.file(Global.Path.modelsCache)
    const stored = parseCatalog(await file.json().catch(() => undefined))
    if (stored) {
      instanceState.cache = stored.catalog
      refreshInBackground()
      return instanceState.cache
    }

    const bundledText = typeof data === "function" ? "{}" : await (data as unknown as () => Promise<string>)()
    const bundled = parseCatalogText(bundledText)
    if (!bundled) log.warn("ignored invalid bundled models catalog")
    instanceState.cache = bundled?.catalog ?? {}
    refreshInBackground()
    return instanceState.cache
  }

  export function refresh(): Promise<RefreshResult> {
    const instanceState = runtimeState()

    if (instanceState.shutdown.signal.aborted) return Promise.resolve({ status: "failed" })
    if (Flag.SYNERGY_DISABLE_MODELS_FETCH) return Promise.resolve({ status: "disabled" })
    if (instanceState.inFlight) return instanceState.inFlight
    instanceState.inFlight = doRefresh().finally(() => {
      instanceState.inFlight = undefined
    })
    return instanceState.inFlight
  }

  export async function stop() {
    const state = runtimeState()
    state.shutdown.abort(new Error("Model catalog is stopping"))
    await state.inFlight
    state.refreshListeners.clear()
  }

  const MIRRORS = [
    "https://models.dev/api.json",
    "https://raw.githubusercontent.com/SII-Holos/synergy-provider-registry/main/models.json",
  ] as const

  async function doRefresh(): Promise<RefreshResult> {
    const instanceState = runtimeState()

    const file = Bun.file(Global.Path.modelsCache)
    log.info("refreshing", { file })
    for (const url of MIRRORS) {
      if (instanceState.shutdown.signal.aborted) return { status: "failed" }
      const result = await fetch(url, {
        headers: { "User-Agent": Installation.userAgent() },
        signal: AbortSignal.any([instanceState.shutdown.signal, AbortSignal.timeout(10 * 1000)]),
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
      if (instanceState.shutdown.signal.aborted) return { status: "failed" }
      await Bun.write(file, JSON.stringify(parsed.catalog))
      instanceState.cache = parsed.catalog
      await notifyRefresh()
      return { status: "refreshed", rejectedProviders: parsed.rejectedProviders, rejectedModels: parsed.rejectedModels }
    }
    return { status: "failed" }
  }
}

export function startModelCatalogRefresh() {
  const timer = setInterval(
    () => void ModelsCatalog.refresh().catch((error) => Log.Default.warn("model catalog refresh failed", { error })),
    60 * 1000 * 60,
  ).unref()
  return () => clearInterval(timer)
}
