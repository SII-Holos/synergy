import { useGlobalSync } from "@/context/global-sync"
import { base64Decode } from "@ericsanchezok/synergy-util/encode"
import { useParams } from "@solidjs/router"
import { createMemo } from "solid-js"

export const popularProviders = ["anthropic", "github-copilot", "openai", "google", "openrouter", "vercel"]

export function useProviders() {
  const globalSync = useGlobalSync()
  const params = useParams()
  const currentDirectory = createMemo(() => base64Decode(params.dir ?? ""))
  const providers = createMemo(() => {
    if (currentDirectory()) {
      const [projectStore] = globalSync.child(currentDirectory())
      return projectStore.provider
    }
    return globalSync.data.provider
  })
  const connected = createMemo(() => providers().all.filter((p) => providers().connected.includes(p.id)))
  const paid = createMemo(() =>
    connected().filter((p) =>
      Object.values(p.models).some((m) => (m.cost?.input ?? 0) > 0 || (m.cost?.output ?? 0) > 0),
    ),
  )
  const popular = createMemo(() => providers().all.filter((p) => popularProviders.includes(p.id)))
  return {
    all: createMemo(() => providers().all),
    default: createMemo(() => providers().default),
    popular,
    connected,
    paid,
  }
}
