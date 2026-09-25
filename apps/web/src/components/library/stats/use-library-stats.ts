import { createResource, createSignal, onCleanup } from "solid-js"
import type { LibraryStatsSnapshot } from "@ericsanchezok/synergy-sdk/client"
import { useGlobalSDK } from "@/context/global-sdk"
import { requestErrorMessage } from "@/utils/error"
export type { LibraryStatsSnapshot }

export function useLibraryStats(input?: Pick<ReturnType<typeof useGlobalSDK>, "client">) {
  const sdk = input ?? useGlobalSDK()
  const [error, setError] = createSignal<string | null>(null)
  const controller = new AbortController()
  onCleanup(() => controller.abort())
  const [data, { refetch }] = createResource<LibraryStatsSnapshot | null>(async (_, { value }) => {
    try {
      setError(null)
      const result = await sdk.client.library.stats(
        { recompute: "true" },
        { throwOnError: true, signal: controller.signal },
      )
      if (!result.data || !("overview" in result.data)) throw new Error("Invalid library statistics response")
      return result.data
    } catch (cause) {
      if (!controller.signal.aborted) setError(requestErrorMessage(cause))
      return value ?? null
    }
  })
  const refresh = () => refetch()
  return { data, error, loading: () => data.loading, refresh, recompute: refresh }
}
