import { createSignal } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import type { Session } from "@ericsanchezok/synergy-sdk/client"

export function DialogSessionRename(props: { session: Session; directory: string }) {
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
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
      showToast({ type: "info", title: "Session renamed", description: value() })
      dialog.close()
    } catch (error) {
      showToast({
        type: "error",
        title: "Rename failed",
        description: error instanceof Error ? error.message : "Request failed",
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog title="Rename session">
      <div class="flex flex-col gap-4 pt-1">
        <TextField
          label="Session title"
          value={title()}
          onChange={setTitle}
          autofocus
          onKeyDown={(event: KeyboardEvent) => {
            if (event.key === "Enter") void save()
          }}
        />
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="small" onClick={() => dialog.close()}>
            Cancel
          </Button>
          <Button type="button" size="small" disabled={!canSave()} onClick={save}>
            {saving() ? "Saving..." : "Rename"}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
