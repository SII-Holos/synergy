import { createSignal } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import type { SessionWorkspaceTransitionRequest } from "./worktree-session"
import "./worktree-transition-dialog.css"

export function WorktreeEnterConfirmDialog(props: {
  sessionID: string
  directory: string
  onConfirm: (request: SessionWorkspaceTransitionRequest) => void
}) {
  const dialog = useDialog()
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
    <Dialog
      title="Move session to worktree?"
      description="Create an isolated checkout and move this session into it. The main checkout stays unchanged."
      class="workspace-transition-dialog"
    >
      <form
        class="wtd-form"
        onSubmit={(event) => {
          event.preventDefault()
          confirm()
        }}
      >
        <TextField autofocus label="Worktree name" placeholder="Auto-generated" value={name()} onChange={setName} />
        <div class="wtd-actions">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="large">
            Create worktree
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
