import type { ConfirmOptions } from "@/components/dialog/confirm-dialog"

export type PluginHostConfirmRequest = {
  title: string
  message: string
  confirmLabel?: string
}

export type PluginHostConfirmShow = (options: ConfirmOptions) => void

/**
 * Bridge Plugin API 3 host.confirm(Promise<boolean>) onto the App ConfirmDialog.
 *
 * title and message pass through from the plugin — they are plugin author content.
 * confirmLabel and cancelLabel are host chrome; the plugin may override confirmLabel
 * with its own content.
 */
export function requestPluginHostConfirm(
  show: PluginHostConfirmShow,
  options: PluginHostConfirmRequest,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    show({
      title: { id: "host.confirm.plugin.title", message: options.title },
      description: { id: "host.confirm.plugin.message", message: options.message },
      confirmLabel: options.confirmLabel?.trim()
        ? { id: "host.confirm.plugin.confirmLabel", message: options.confirmLabel.trim() }
        : { id: "app.common.confirm", message: "Confirm" },
      cancelLabel: { id: "app.common.cancel", message: "Cancel" },
      tone: "neutral",
      onConfirm: () => {
        finish(true)
      },
      onConfirmed: () => {
        finish(true)
      },
      onDismiss: () => {
        finish(false)
      },
    })
  })
}
