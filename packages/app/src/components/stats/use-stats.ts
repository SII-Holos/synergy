import { createResource } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import type { StatsSnapshot } from "@ericsanchezok/synergy-sdk"

export function useStats() {
  const sdk = useGlobalSDK()

  const [data, { refetch }] = createResource(async (): Promise<StatsSnapshot | null> => {
    try {
      const res = await sdk.client.stats.get()
      return res.data ?? null
    } catch {
      return null
    }
  })

  const refresh = () => refetch()

  return { data, refresh }
}

export function formatCompact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K"
  return n.toLocaleString()
}

export function formatCost(n: number): string {
  if (n >= 1_000) return "$" + (n / 1_000).toFixed(1) + "K"
  if (n >= 1) return "$" + n.toFixed(2)
  return "$" + n.toFixed(4)
}
