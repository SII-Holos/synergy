import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import type { StorageUpgradeStatus } from "@ericsanchezok/synergy-sdk/client"
import { useGlobalSDK } from "@/context/global-sdk"
import { useServer } from "@/context/server"
import { useLocale } from "@/context/locale"

export function UpgradeStatus() {
  const sdk = useGlobalSDK()
  const server = useServer()
  const { i18n } = useLocale()
  const [status, setStatus] = createSignal<StorageUpgradeStatus>()
  createEffect(() => {
    server.url
    setStatus(undefined)
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      try {
        const { data } = await sdk.client.storage.upgradeStatus()
        if (disposed) return
        setStatus(data)
        if (!data || !(data.pending + data.partial)) return
      } catch {
        if (disposed) return
      }
      timer = setTimeout(refresh, document.hidden ? 10_000 : 2000)
    }
    void refresh()
    onCleanup(() => {
      disposed = true
      clearTimeout(timer)
    })
  })
  return (
    <Show when={status() && status()!.imported < status()!.total}>
      <span role="status" class="text-text-weak text-ui-small px-2">
        {status()!.pending + status()!.partial > 0
          ? i18n._({
              id: "app.upgrade.progress",
              message: "Preparing history: {done}/{total}",
              values: { done: status()!.imported, total: status()!.total },
            })
          : i18n._({
              id: "app.upgrade.attention",
              message: "{count} historical sessions need repair",
              values: { count: status()!.quarantined },
            })}
      </span>
    </Show>
  )
}
