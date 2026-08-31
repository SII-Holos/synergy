import path from "path"
import fs from "fs/promises"
const action = process.argv[2]
let requests = 0

function refreshedCatalog() {
  return JSON.parse(process.env.MODELS_REFRESH_PAYLOAD!)
}

async function seedInitialCatalog() {
  const payload = process.env.MODELS_INITIAL_PAYLOAD
  if (!payload) return
  const cachePath = path.join(process.env.SYNERGY_HOME!, ".synergy", "cache", "models.json")
  await fs.mkdir(path.dirname(cachePath), { recursive: true })
  await Bun.write(cachePath, payload)
}

if (action === "refresh") {
  const waiters: Array<() => void> = []
  let released = false
  globalThis.fetch = (() => {
    requests++
    return new Promise<Response>((resolve) => {
      const respond = () =>
        resolve(
          Response.json(
            process.env.MODELS_REFRESH_PAYLOAD
              ? refreshedCatalog()
              : {
                  "refreshed-provider": {
                    id: "refreshed-provider",
                    name: "Refreshed provider",
                    env: [],
                    models: {
                      "test-model": {
                        id: "test-model",
                        name: "Test model",
                        release_date: "2026-01-01",
                        attachment: false,
                        reasoning: false,
                        tool_call: true,
                        limit: { context: 4096, output: 1024 },
                      },
                    },
                  },
                },
          ),
        )
      if (released) respond()
      else waiters.push(respond)
    })
  }) as unknown as typeof fetch

  const { ModelsDev } = await import("../../../src/provider/models")
  await seedInitialCatalog()
  const pending = ModelsDev.get()
  const first = await Promise.race([
    pending.then((catalog) => ({ returned: true as const, catalog })),
    Bun.sleep(100).then(() => ({ returned: false as const })),
  ])
  released = true
  for (const respond of waiters.splice(0)) respond()
  const initial = await pending
  await ModelsDev.refresh()
  const memory = await ModelsDev.get()
  const disk = await Bun.file(path.join(process.env.SYNERGY_HOME!, ".synergy", "cache", "models.json")).json()
  process.stdout.write(
    JSON.stringify({
      returnedBeforeRefresh: first.returned,
      initialProviders: Object.keys(initial),
      memoryProviders: Object.keys(memory),
      diskProviders: Object.keys(disk),
      requests,
    }),
  )
} else if (action === "routes") {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url === "https://models.dev/api.json") requests++
    return Promise.reject(new Error("unexpected external fetch"))
  }) as unknown as typeof fetch

  const { Server } = await import("../../../src/server/server")
  const app = Server.App()
  const providerResponse = await app.request("/provider")
  const provider = await providerResponse.json()
  const bootstrapResponse = await app.request("/scope/bootstrap", {
    headers: { "x-synergy-directory": process.env.MODELS_OFFLINE_PROJECT! },
  })
  const bootstrap = await bootstrapResponse.json()
  process.stdout.write(
    JSON.stringify({
      providerStatus: providerResponse.status,
      bootstrapStatus: bootstrapResponse.status,
      providerCount: Array.isArray(provider.all) ? provider.all.length : 0,
      providerIDs: Array.isArray(provider.all) ? provider.all.map((item: { id: string }) => item.id) : [],
      bootstrapProviderCount: Array.isArray(bootstrap.provider?.all) ? bootstrap.provider.all.length : 0,
      bootstrapProviderIDs: Array.isArray(bootstrap.provider?.all)
        ? bootstrap.provider.all.map((item: { id: string }) => item.id)
        : [],
      requests,
    }),
    () => process.exit(0),
  )
} else if (action === "invalid-refresh") {
  globalThis.fetch = (() => Promise.resolve(Response.json(refreshedCatalog()))) as unknown as typeof fetch
  const [{ ModelsDev }, { Server }] = await Promise.all([
    import("../../../src/provider/models"),
    import("../../../src/server/server"),
  ])
  await seedInitialCatalog()
  await ModelsDev.get()
  await ModelsDev.refresh()
  const memory = await ModelsDev.get()
  const disk = await Bun.file(path.join(process.env.SYNERGY_HOME!, ".synergy", "cache", "models.json")).json()
  const app = Server.App()
  const providerResponse = await app.request("/provider")
  const provider = await providerResponse.json()
  const bootstrapResponse = await app.request("/scope/bootstrap", {
    headers: { "x-synergy-directory": process.env.MODELS_OFFLINE_PROJECT! },
  })
  const bootstrap = await bootstrapResponse.json()
  process.stdout.write(
    JSON.stringify({
      memoryProviders: Object.keys(memory),
      diskProviders: Object.keys(disk),
      providerStatus: providerResponse.status,
      providerCatalogProviders: provider.catalogProviders,
      bootstrapCatalogProviders: bootstrap.provider.catalogProviders,
    }),
    () => process.exit(0),
  )
} else if (action === "refresh-routes") {
  const waiters: Array<() => void> = []
  let released = false
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url !== "https://models.dev/api.json") return Promise.reject(new Error(`unexpected external fetch: ${url}`))
    return new Promise<Response>((resolve) => {
      const respond = () => resolve(Response.json(refreshedCatalog()))
      if (released) respond()
      else waiters.push(respond)
    })
  }) as unknown as typeof fetch
  const [{ ModelsDev }, { Server }, { GlobalBus }, { RuntimeReload }, { RuntimeReloadExecutor }] = await Promise.all([
    import("../../../src/provider/models"),
    import("../../../src/server/server"),
    import("../../../src/bus/global"),
    import("../../../src/runtime/reload"),
    import("../../../src/config/reload-executor"),
  ])
  RuntimeReloadExecutor.setExecutor((input, options) => RuntimeReload.reload(input, options))
  RuntimeReloadExecutor.setGlobalExecutor((input, options) => RuntimeReload.reloadGlobal(input, options))
  const runtimeReloads: Array<{ hasDirectory: boolean; executed: string[]; cascaded: string[] }> = []
  GlobalBus.on("event", (event) => {
    if (event.payload?.type !== RuntimeReload.Event.Reloaded.type) return
    runtimeReloads.push({
      hasDirectory: event.directory !== undefined,
      executed: event.payload.properties.executed,
      cascaded: event.payload.properties.cascaded,
    })
  })
  await seedInitialCatalog()
  const app = Server.App()
  const initialResponse = await app.request("/provider")
  const initial = await initialResponse.json()
  released = true
  for (const respond of waiters.splice(0)) respond()
  await ModelsDev.refresh()
  const refreshedResponse = await app.request("/provider")
  const refreshed = await refreshedResponse.json()
  const bootstrapResponse = await app.request("/scope/bootstrap", {
    headers: { "x-synergy-directory": process.env.MODELS_OFFLINE_PROJECT! },
  })
  const bootstrap = await bootstrapResponse.json()
  process.stdout.write(
    JSON.stringify({
      initialCatalogProviders: initial.catalogProviders,
      initialConnected: initial.connected,
      refreshedCatalogProviders: refreshed.catalogProviders,
      refreshedConnected: refreshed.connected,
      bootstrapCatalogProviders: bootstrap.provider.catalogProviders,
      bootstrapConnected: bootstrap.provider.connected,
      runtimeReloads,
    }),
    () => process.exit(0),
  )
} else if (action === "refresh-during-discovery") {
  let modelsRefreshStarted!: () => void
  const didModelsRefreshStart = new Promise<void>((resolve) => {
    modelsRefreshStarted = resolve
  })
  let releaseModelsRefresh!: () => void
  globalThis.fetch = (() => {
    modelsRefreshStarted()
    return new Promise<Response>((resolve) => {
      releaseModelsRefresh = () => resolve(Response.json(refreshedCatalog()))
    })
  }) as unknown as typeof fetch
  const [{ ModelsDev }, { ProviderCatalog }, { ProviderProfile }, { Global }] = await Promise.all([
    import("../../../src/provider/models"),
    import("../../../src/provider/catalog"),
    import("../../../src/provider/profile"),
    import("../../../src/global"),
  ])
  await seedInitialCatalog()
  await ModelsDev.get()
  await didModelsRefreshStart

  let discoveryStarted!: () => void
  const didDiscoveryStart = new Promise<void>((resolve) => {
    discoveryStarted = resolve
  })
  let releaseDiscovery!: (entries: Array<{ id: string }>) => void
  const providerID = "concurrent-discovery"
  ProviderProfile.register({
    id: providerID,
    name: "Concurrent Discovery",
    authKind: "none",
    modelsDevProviderID: "openai",
    fallbackModels: ["fallback-model"],
    modelCatalogIdentity: () => "concurrent-discovery",
    fetchModelCatalog: () => {
      discoveryStarted()
      return new Promise((resolve) => {
        releaseDiscovery = resolve
      })
    },
  })

  const discovery = ProviderCatalog.refresh(providerID)
  await didDiscoveryStart
  releaseModelsRefresh()
  await ModelsDev.refresh()
  releaseDiscovery([{ id: "discovered-model" }])
  await discovery

  const persisted = await Bun.file(Global.Path.providerModelCatalogCache).json()
  const snapshot = persisted.snapshots.find((candidate: { providerID: string }) => candidate.providerID === providerID)
  process.stdout.write(
    JSON.stringify({ activeModels: snapshot?.activeModels.map((model: { id: string }) => model.id) ?? [] }),
    () => process.exit(0),
  )
} else if (action === "refresh-after-discovery") {
  let modelsRefreshStarted!: () => void
  const didModelsRefreshStart = new Promise<void>((resolve) => {
    modelsRefreshStarted = resolve
  })
  let releaseModelsRefresh!: () => void
  globalThis.fetch = (() => {
    modelsRefreshStarted()
    return new Promise<Response>((resolve) => {
      releaseModelsRefresh = () => resolve(Response.json(refreshedCatalog()))
    })
  }) as unknown as typeof fetch
  const [{ ModelsDev }, { ProviderCatalog }, { ProviderProfile }] = await Promise.all([
    import("../../../src/provider/models"),
    import("../../../src/provider/catalog"),
    import("../../../src/provider/profile"),
  ])
  await seedInitialCatalog()
  await ModelsDev.get()
  await didModelsRefreshStart

  const providerID = "fresh-discovery"
  ProviderProfile.register({
    id: providerID,
    name: "Fresh Discovery",
    authKind: "none",
    modelsDevProviderID: "openai",
    fallbackModels: ["fallback-model"],
    modelCatalogIdentity: () => "fresh-discovery",
    fetchModelCatalog: async () => [{ id: "discovered-model" }],
  })
  await ProviderCatalog.refresh(providerID)
  const sourceBefore = ProviderCatalog.modelCatalogState(providerID)?.source

  releaseModelsRefresh()
  await ModelsDev.refresh()
  await ProviderCatalog.resolve({
    config: { providerCatalog: { enabled: false, offlineCache: false } },
    includeLive: true,
  })
  const sourceAfter = ProviderCatalog.modelCatalogState(providerID)?.source

  process.stdout.write(JSON.stringify({ sourceBefore, sourceAfter }), () => process.exit(0))
} else {
  throw new Error(`Unknown action: ${action}`)
}
