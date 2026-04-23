import { createResource, createSignal } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"

type StatsSnapshot = import("@ericsanchezok/synergy-sdk").StatsSnapshot

type StatsProgress = {
  phase: "scan" | "digest" | "bucket" | "snapshot"
  current: number
  total: number
  message?: string
}

type StatsProgressEvent =
  | { type: "progress"; progress?: StatsProgress }
  | { type: "done"; snapshot?: StatsSnapshot }
  | { type: "error"; message?: string }

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string") return error
  return "Unable to load usage stats right now."
}

export function useStats() {
  const sdk = useGlobalSDK()
  const [error, setError] = createSignal<string | null>(null)
  const [syncError, setSyncError] = createSignal<string | null>(null)
  const [syncing, setSyncing] = createSignal(false)
  const [progress, setProgress] = createSignal<StatsProgress | null>(null)

  const [data, { refetch, mutate }] = createResource(async (): Promise<StatsSnapshot | null> => {
    try {
      setError(null)
      const res = await sdk.client.stats.get()
      return res.data ?? null
    } catch (err) {
      setError(getErrorMessage(err))
      return null
    }
  })

  const refresh = () => refetch()

  async function sync() {
    if (syncing()) return
    setSyncing(true)
    setSyncError(null)
    setProgress({ phase: "scan", current: 0, total: 1, message: "Starting stats sync..." })

    const stream = new EventSource(`${sdk.url}/stats/progress`)

    await new Promise<void>((resolve) => {
      const finish = () => {
        stream.close()
        setSyncing(false)
        resolve()
      }

      stream.onmessage = (event) => {
        let payload: StatsProgressEvent
        try {
          payload = JSON.parse(event.data)
        } catch {
          return
        }

        if (payload.type === "progress" && payload.progress) {
          setProgress(payload.progress)
          return
        }

        if (payload.type === "done") {
          if (payload.snapshot) {
            mutate(() => payload.snapshot)
            setError(null)
          }
          setProgress({ phase: "snapshot", current: 1, total: 1, message: "Stats synced" })
          finish()
          return
        }

        if (payload.type === "error") {
          setSyncError(payload.message ?? "Stats sync failed.")
          finish()
        }
      }

      stream.onerror = () => {
        setSyncError("Stats sync connection dropped.")
        finish()
      }
    })
  }

  return {
    data,
    error,
    loading: data.loading,
    refresh,
    sync,
    syncing,
    progress,
    syncError,
  }
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
