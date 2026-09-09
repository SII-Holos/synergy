import type { JSX } from "solid-js"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"

export function SettingsDialogFrame(props: { ariaLabel: string; children: JSX.Element }) {
  return (
    <Dialog ariaLabel={props.ariaLabel} class="settings-dialog-panel" dismissible={false}>
      {props.children}
    </Dialog>
  )
}
