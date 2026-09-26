import { createResource, createSignal, onCleanup } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLocale } from "@/context/locale"
import { S } from "./stats-i18n"
import { requestErrorMessage } from "@/utils/error"

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

export function useStats() {
  const sdk = useGlobalSDK()
  const { i18n } = useLocale()
  const [error, setError] = createSignal<string | null>(null)
  const [syncError, setSyncError] = createSignal<string | null>(null)
  const [syncing, setSyncing] = createSignal(false)
  const [progress, setProgress] = createSignal<StatsProgress | null>(null)

  const controller = new AbortController()
  let closeStream: (() => void) | undefined
  onCleanup(() => {
    controller.abort()
    closeStream?.()
  })

  const [data, { mutate }] = createResource(async (): Promise<StatsSnapshot | null> => {
    try {
      setError(null)
      const res = await sdk.client.global.stats.get(undefined, { signal: controller.signal, throwOnError: true })
      if (!res.data && !controller.signal.aborted) void sync()
      return res.data ?? null
    } catch (err) {
      if (controller.signal.aborted) return null
      const msg = requestErrorMessage(err, i18n._(S.loadFetchError.id))
      setError(msg || i18n._(S.loadFetchError.id))
      return null
    }
  })

  const refresh = () => sync()

  async function sync() {
    if (syncing()) return
    setSyncing(true)
    setSyncError(null)
    setProgress({ phase: "scan", current: 0, total: 1, message: i18n._(S.syncStarting.id) })

    const stream = new EventSource(`${sdk.url}/global/stats/progress`)

    await new Promise<void>((resolve) => {
      const finish = () => {
        closeStream = undefined
        stream.close()
        setSyncing(false)
        resolve()
      }

      closeStream = finish

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
          if (!payload.snapshot) setSyncError(i18n._(S.syncFailed.id))
          setProgress({ phase: "snapshot", current: 1, total: 1, message: i18n._(S.syncDone.id) })
          finish()
          return
        }

        if (payload.type === "error") {
          setSyncError(payload.message ?? i18n._(S.syncFailed.id))
          finish()
        }
      }

      stream.onerror = () => {
        setSyncError(i18n._(S.syncDropped.id))
        finish()
      }
    })
  }

  return {
    data,
    error,
    loading: () => data.loading,
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
  return String(n)
}

export function formatCost(n: number): string {
  if (n >= 1_000) return "$" + (n / 1_000).toFixed(1) + "K"
  if (n >= 1) return "$" + n.toFixed(2)
  return "$" + n.toFixed(4)
}
