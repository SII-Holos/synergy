import { onCleanup, onMount, type ParentProps } from "solid-js"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useLingui } from "@lingui/solid"
import { workspace as W } from "@/locales/messages"
import { WorkspaceMobileHeader } from "./mobile-header"
import "./mobile-workspace-dialog.css"

export function MobileWorkspaceDialog(props: ParentProps<{ onClose: () => void }>) {
  const dialog = useDialog()
  const { _ } = useLingui()
  let id: string | undefined
  let disposed = false
  onMount(() => {
    id = dialog.push(
      () => (
        <Dialog ariaLabel={_(W.mobileHeader)} class="mobile-workspace-dialog">
          <WorkspaceMobileHeader onClose={() => dialog.close(id)} />
          <div class="mobile-workbench-overlay relative flex-1 min-h-0">{props.children}</div>
        </Dialog>
      ),
      () => {
        if (!disposed) props.onClose()
      },
    )
  })
  onCleanup(() => {
    disposed = true
    if (id) dialog.close(id)
  })
  return null
}
