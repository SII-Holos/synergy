import { Button } from "@ericsanchezok/synergy-ui/button"
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
  const [controlError, setControlError] = createSignal(false)
  const [controlling, setControlling] = createSignal(false)
  const control = async () => {
    setControlling(true)
    setControlError(false)
    try {
      setStatus(
        (
          await sdk.client.storage.controlUpgrade(
            { action: status()?.paused ? "resume" : "pause" },
            { throwOnError: true },
          )
        ).data,
      )
    } catch {
      setControlError(true)
    } finally {
      setControlling(false)
    }
  }
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
    <Show
      when={
        status() && (status()!.imported < status()!.total || !status()!.backup.complete || status()!.backup.attention)
      }
    >
      <div class="flex items-center gap-2 min-w-0 px-2 text-text-weak text-ui-small">
        <span role="status">
          {status()!.backup.attention
            ? i18n._({ id: "app.upgrade.backupAttention", message: "Recovery backup needs attention" })
            : status()!.paused
              ? i18n._({ id: "app.upgrade.paused", message: "History preparation paused" })
              : status()!.pending + status()!.partial > 0
                ? i18n._({
                    id: "app.upgrade.progress",
                    message: "Preparing history: {done}/{total}",
                    values: { done: status()!.imported, total: status()!.total },
                  })
                : !status()!.backup.complete
                  ? i18n._({
                      id: "app.upgrade.backup",
                      message: "Completing recovery backup: {done}/{total}",
                      values: { done: status()!.backup.sealed, total: status()!.backup.total },
                    })
                  : i18n._({
                      id: "app.upgrade.attention",
                      message: "{count} historical sessions need repair",
                      values: { count: status()!.quarantined },
                    })}
        </span>
        <Button variant="ghost" size="small" disabled={controlling()} onClick={() => void control()}>
          {status()!.paused
            ? i18n._({ id: "app.upgrade.resume", message: "Resume" })
            : i18n._({ id: "app.upgrade.pause", message: "Pause" })}
        </Button>
        <Show when={controlError()}>
          <span role="alert">
            {i18n._({ id: "app.upgrade.controlFailed", message: "Could not update preparation. Try again." })}
          </span>
        </Show>
      </div>
    </Show>
  )
}
