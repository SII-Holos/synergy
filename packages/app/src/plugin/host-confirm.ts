import type { ConfirmOptions } from "@/components/dialog/confirm-dialog"

export type PluginHostConfirmRequest = {
  title: string
  message: string
  confirmLabel?: string
}

export type PluginHostConfirmShow = (options: ConfirmOptions) => void

/** Bridge Plugin API 3 host.confirm(Promise<boolean>) onto the App ConfirmDialog. */
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
      title: options.title,
      description: options.message,
      confirmLabel: options.confirmLabel?.trim() || "Confirm",
      cancelLabel: "Cancel",
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
