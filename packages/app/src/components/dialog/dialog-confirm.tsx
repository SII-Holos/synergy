import { Button } from "@ericsanchezok/synergy-ui/button"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import "./dialog-confirm.css"

export function DialogConfirm(props: {
  title: string
  description: string
  confirmLabel?: string
  cancelLabel?: string
  confirmVariant?: "primary" | "secondary"
  onConfirm: () => void | Promise<void>
}) {
  const dialog = useDialog()

  return (
    <Dialog title={props.title} description={props.description} class="dialog-confirm-compact">
      <div class="dialog-confirm-actions">
        <Button type="button" variant="ghost" size="small" onClick={() => dialog.close()}>
          {props.cancelLabel ?? "Keep Editing"}
        </Button>
        <Button
          type="button"
          variant={props.confirmVariant ?? "primary"}
          size="small"
          class="dialog-confirm-danger"
          onClick={async () => {
            await props.onConfirm()
            dialog.close()
          }}
        >
          {props.confirmLabel ?? "Discard"}
        </Button>
      </div>
    </Dialog>
  )
}
