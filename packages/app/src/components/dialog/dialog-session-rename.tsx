import { useLingui } from "@lingui/solid"
import { dialog } from "@/locales/messages"
import { createSignal } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useDialog as useDialogContext } from "@ericsanchezok/synergy-ui/context/dialog"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import type { Session } from "@ericsanchezok/synergy-sdk/client"

export function DialogSessionRename(props: { session: Session; directory: string }) {
  const dialogContext = useDialogContext()
  const globalSDK = useGlobalSDK()
  const { _ } = useLingui()
  const [title, setTitle] = createSignal(props.session.title || "")
  const [saving, setSaving] = createSignal(false)

  const value = () => title().trim()
  const canSave = () => value().length > 0 && value() !== props.session.title && !saving()

  async function save() {
    if (!canSave()) return
    setSaving(true)
    try {
      await globalSDK.client.session.update({
        directory: props.directory,
        sessionID: props.session.id,
        title: value(),
      })
      showToast({ type: "info", title: _(dialog.sessionRenamed), description: value() })
      dialogContext.close()
    } catch (error) {
      showToast({
        type: "error",
        title: _(dialog.sessionRenameFailed),
        description: error instanceof Error ? error.message : _(dialog.sessionRenameRequestFailed),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog title={_(dialog.renameSession)} size="compact">
      <div data-slot="dialog-form">
        <TextField
          label={_(dialog.sessionTitle)}
          value={title()}
          onChange={setTitle}
          autofocus
          onKeyDown={(event: KeyboardEvent) => {
            if (event.key === "Enter") void save()
          }}
        />
        <div data-slot="dialog-actions">
          <Button type="button" variant="ghost" size="large" onClick={() => dialogContext.close()}>
            {_(dialog.cancel)}
          </Button>
          <Button type="button" variant="primary" size="large" disabled={!canSave()} onClick={save}>
            {saving() ? _(dialog.saving) : _(dialog.rename)}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
