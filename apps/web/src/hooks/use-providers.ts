import { useGlobalSync } from "@/context/global-sync"
import { base64Decode } from "@ericsanchezok/synergy-util/encode"
import { useParams } from "@solidjs/router"
import { createMemo } from "solid-js"
import { isRecommendedProvider } from "@/components/provider/provider-recommendation"

export function useProviders() {
  const globalSync = useGlobalSync()
  const params = useParams()
  const currentDirectory = createMemo(() => base64Decode(params.dir ?? ""))
  const providers = createMemo(() => {
    if (currentDirectory()) {
      const [projectStore] = globalSync.ensureScopeState(currentDirectory())
      return projectStore.provider
    }
    return globalSync.data.provider
  })
  const connected = createMemo(() => providers().all.filter((provider) => providers().connected.includes(provider.id)))
  const available = createMemo(() =>
    providers().all.filter((provider) => {
      if (!providers().connected.includes(provider.id)) return false
      return providers().runtimeAvailability?.[provider.id]?.available ?? true
    }),
  )
  const popular = createMemo(() => providers().all.filter((p) => isRecommendedProvider(providers().profiles, p.id)))
  return {
    all: createMemo(() => providers().all),
    default: createMemo(() => providers().default),
    popular,
    connected,
    available,
    ensureCatalog: () => globalSync.loadModelCatalog(currentDirectory() || "home"),
    ensureModels: (keys: { providerID: string; modelID: string }[]) =>
      globalSync.ensureModels(currentDirectory() || "home", keys),
    complete: () => providers().complete !== false,
    resolved: (key: { providerID: string; modelID: string }) =>
      !!providers().all.find((provider) => provider.id === key.providerID)?.models[key.modelID] ||
      providers().resolvedModels?.includes(JSON.stringify([key.providerID, key.modelID])) === true,
  }
}
