import { isHomeScope } from "@/utils/scope"
import { useGlobalSync } from "@/context/global-sync"
import { base64Decode } from "@ericsanchezok/synergy-util/encode"
import { useParams } from "@/context/session-route"
import { createMemo } from "solid-js"
import { isRecommendedProvider } from "@/components/provider/provider-recommendation"
import { resolveModelReadiness } from "@/components/provider/model-readiness"

export function useProviders() {
  const globalSync = useGlobalSync()
  const params = useParams()
  const currentDirectory = createMemo(() => base64Decode(params.dir ?? ""))
  const scope = createMemo(() => {
    if (currentDirectory() && !isHomeScope(currentDirectory())) {
      const [projectStore] = globalSync.ensureScopeState(currentDirectory())
      return projectStore
    }
  })
  const providers = createMemo(() => scope()?.provider ?? globalSync.data.provider)
  const connected = createMemo(() => providers().all.filter((provider) => providers().connected.includes(provider.id)))
  const available = createMemo(() =>
    providers().all.filter((provider) => {
      if (!providers().connected.includes(provider.id)) return false
      return providers().runtimeAvailability?.[provider.id]?.available ?? true
    }),
  )
  const popular = createMemo(() => providers().all.filter((p) => isRecommendedProvider(providers().profiles, p.id)))
  return {
    readiness: createMemo(() => (scope()?.status === "loading" ? undefined : resolveModelReadiness(providers()))),
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
