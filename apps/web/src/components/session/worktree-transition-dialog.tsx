import { createSignal } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import type { SessionWorkspaceTransitionRequest } from "./worktree-session"
import { useLocale } from "@/context/locale"
import { S } from "./session-i18n"
import "./worktree-transition-dialog.css"

export function WorktreeEnterConfirmDialog(props: {
  sessionID: string
  directory: string
  onConfirm: (request: SessionWorkspaceTransitionRequest) => void
}) {
  const dialog = useDialog()
  const { i18n } = useLocale()
  const _ = (d: { id: string; message: string }) => i18n._(d)
  const [name, setName] = createSignal("")

  const confirm = () => {
    const trimmed = name().trim()
    const request: SessionWorkspaceTransitionRequest = {
      operation: "enter",
      sessionID: props.sessionID,
      directory: props.directory,
      name: trimmed.length > 0 ? trimmed : undefined,
    }
    dialog.close()
    queueMicrotask(() => props.onConfirm(request))
  }

  return (
    <Dialog title={_(S.worktreeDialogTitle)} description={_(S.worktreeDialogDesc)} class="workspace-transition-dialog">
      <form
        class="wtd-form"
        onSubmit={(event) => {
          event.preventDefault()
          confirm()
        }}
      >
        <TextField
          autofocus
          label={_(S.worktreeDialogNameLabel)}
          placeholder={_(S.worktreeDialogNamePlaceholder)}
          value={name()}
          onChange={setName}
        />
        <div class="wtd-actions">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
            {_(S.worktreeDialogCancel)}
          </Button>
          <Button type="submit" variant="primary" size="large">
            {_(S.worktreeDialogCreate)}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
