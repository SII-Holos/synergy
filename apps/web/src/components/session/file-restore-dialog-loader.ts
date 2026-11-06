import { createComponent, onCleanup } from "solid-js"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { useSDK } from "@/context/sdk"
import type { FileRestoreSelection } from "./dialog-file-restore"

export function useFileRestore(sessionID: () => string | undefined) {
  const dialog = useDialog()
  const sdk = useSDK()
  let disposed = false
  let loading = false
  onCleanup(() => {
    disposed = true
  })
  return async (selection?: FileRestoreSelection) => {
    const id = sessionID()
    if (!id || loading) return
    const context = { url: sdk.url, scope: sdk.scopeKey, dialogID: dialog.active?.id }
    loading = true
    try {
      const module = await import("./dialog-file-restore")
      if (
        disposed ||
        sessionID() !== id ||
        sdk.url !== context.url ||
        sdk.scopeKey !== context.scope ||
        dialog.active?.id !== context.dialogID
      )
        return
      dialog.push(() => createComponent(module.DialogFileRestore, { sessionID: id, selection }))
    } catch (error) {
      if (!disposed) showToast({ type: "error", title: error instanceof Error ? error.message : String(error) })
    } finally {
      loading = false
    }
  }
}
