import { useParams, useSearchParams } from "@solidjs/router"
import { MarketplacePage } from "./MarketplacePage"
import type { RegistrySource } from "./PluginDetailDialog"

export function PluginDetailPage() {
  const params = useParams<{ pluginId: string }>()
  const [searchParams] = useSearchParams()
  const source = (): RegistrySource => (searchParams.source === "local" ? "local" : "official")

  return <MarketplacePage initialPluginId={decodeURIComponent(params.pluginId)} initialSource={source()} />
}
