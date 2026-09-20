import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import type { StorageUpgradeStatus } from "@ericsanchezok/synergy-sdk/client"
import { useGlobalSDK } from "@/context/global-sdk"
import { useServer } from "@/context/server"
import { useLocale } from "@/context/locale"
import { createUpgradeStatusController } from "./upgrade-status-controller"

export function UpgradeStatus() {
  const sdk = useGlobalSDK()
  const server = useServer()
  const { i18n } = useLocale()
  const [status, setStatus] = createSignal<StorageUpgradeStatus>()
  createEffect(() => {
    server.url
    setStatus(undefined)
    const controller = createUpgradeStatusController({
      load: async () => (await sdk.client.storage.upgradeStatus()).data,
      publish: setStatus,
      hidden: () => document.hidden,
    })
    void controller.refresh()
    onCleanup(controller.dispose)
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
