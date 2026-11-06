import { onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { ExperienceDetailInfo } from "@ericsanchezok/synergy-sdk/client"

type Detail = { data?: ExperienceDetailInfo; loading: boolean; error?: unknown }

export function createExperienceDetails(
  fetchDetail: (id: string, signal: AbortSignal) => Promise<ExperienceDetailInfo>,
) {
  const [entries, setEntries] = createStore<Record<string, Detail>>({})
  const pending = new Map<string, Promise<void>>()
  const controller = new AbortController()
  onCleanup(() => controller.abort())

  function load(id: string): Promise<void> {
    if (controller.signal.aborted || entries[id]?.data) return Promise.resolve()
    const current = pending.get(id)
    if (current) return current
    setEntries(id, { loading: true, error: undefined })
    const request = fetchDetail(id, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setEntries(id, reconcile({ data, loading: false }))
      })
      .catch((error) => {
        if (!controller.signal.aborted) setEntries(id, { loading: false, error })
      })
      .finally(() => pending.delete(id))
    pending.set(id, request)
    return request
  }

  return { read: (id: string): Detail | undefined => entries[id], load }
}
