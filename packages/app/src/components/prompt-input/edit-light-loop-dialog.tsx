import { createMemo, createSignal, Show, type Accessor } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { requestErrorMessage } from "@/utils/error"
import { resolveLightLoopControlState } from "./light-loop-control"

export function EditLightLoopDialog(props: {
  taskDescription: string
  active: Accessor<boolean>
  working: Accessor<boolean>
  reviewPending: Accessor<boolean>
  onSave: (taskDescription: string) => Promise<void>
}) {
  const dialog = useDialog()
  const [taskDescription, setTaskDescription] = createSignal(props.taskDescription)
  const [saving, setSaving] = createSignal(false)
  const state = createMemo(() =>
    resolveLightLoopControlState({
      active: props.active(),
      working: props.working(),
      reviewPending: props.reviewPending(),
    }),
  )
  const value = () => taskDescription().trim()
  const canSave = () =>
    state().mode === "editable" && value().length > 0 && value() !== props.taskDescription.trim() && !saving()

  const save = async () => {
    if (!canSave()) return
    setSaving(true)
    try {
      await props.onSave(value())
      showToast({
        type: "info",
        title: "Light Loop task updated",
        description: "The next model step will use the revised task.",
      })
      dialog.close()
    } catch (error) {
      showToast({
        type: "error",
        title: "Failed to update Light Loop",
        description: requestErrorMessage(error),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog title="Light Loop task" size="form">
      <div data-slot="dialog-form">
        <TextField
          label="Task description"
          value={taskDescription()}
          onChange={setTaskDescription}
          multiline
          rows={7}
          autofocus={state().mode === "editable"}
          readOnly={state().mode === "readOnly"}
          description={state().description}
        />
        <div data-slot="dialog-actions">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
            {state().mode === "editable" ? "Cancel" : "Close"}
          </Button>
          <Show when={state().mode === "editable"}>
            <Button type="button" variant="primary" size="large" disabled={!canSave()} onClick={save}>
              {saving() ? "Saving..." : "Save task"}
            </Button>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}
