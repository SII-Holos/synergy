import { createMediaQuery } from "@solid-primitives/media"
import { createEffect, onCleanup, onMount, type ParentProps } from "solid-js"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import "./mobile-drawer.css"

export function MobileDrawerDialog(props: ParentProps<{ label: string; side: "left" | "right"; onClose: () => void }>) {
  const dialog = useDialog()
  const desktop = createMediaQuery("(min-width: 768px)")
  createEffect(() => {
    if (desktop()) props.onClose()
  })
  let id: string | undefined
  let disposed = false
  onMount(() => {
    if (desktop()) return
    id = dialog.push(
      () => (
        <Dialog ariaLabel={props.label} class={`mobile-drawer-overlay mobile-drawer-${props.side}`}>
          {props.children}
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
