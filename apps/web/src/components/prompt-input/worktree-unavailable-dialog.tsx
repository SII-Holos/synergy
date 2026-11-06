import { Button } from "@ericsanchezok/synergy-ui/button"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { useLocale } from "@/context/locale"
import { PI } from "./prompt-input-i18n"

export function WorktreeUnavailableDialog() {
  const dialog = useDialog()
  const { i18n } = useLocale()

  return (
    <Dialog
      title={i18n._(PI.worktreeUnavailableTitle)}
      description={i18n._(PI.worktreeUnavailableDescription)}
      size="compact"
    >
      <div data-slot="dialog-actions">
        <Button type="button" variant="primary" size="large" autofocus onClick={() => dialog.close()}>
          {i18n._(PI.worktreeUnavailableClose)}
        </Button>
      </div>
    </Dialog>
  )
}
