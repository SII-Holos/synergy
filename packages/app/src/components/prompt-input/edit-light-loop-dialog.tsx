import { createMemo, createSignal, Show, type Accessor } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { requestErrorMessage } from "@/utils/error"
import { useLocale } from "@/context/locale"
import { resolveLightLoopControlState } from "./light-loop-control"
import { PI } from "./prompt-input-i18n"

export function EditLightLoopDialog(props: {
  taskDescription: string
  active: Accessor<boolean>
  working: Accessor<boolean>
  reviewPending: Accessor<boolean>
  onSave: (taskDescription: string) => Promise<void>
}) {
  const dialog = useDialog()
  const { i18n } = useLocale()
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
  const stateDescription = () => {
    switch (state().reason) {
      case "inactive":
        return i18n._(PI.lightLoopTaskInactive)
      case "reviewPending":
        return i18n._(PI.lightLoopTaskReviewPending)
      case "working":
        return i18n._(PI.lightLoopTaskWorking)
      case "editable":
        return i18n._(PI.lightLoopTaskEditable)
    }
  }

  const save = async () => {
    if (!canSave()) return
    setSaving(true)
    try {
      await props.onSave(value())
      showToast({
        type: "info",
        title: i18n._(PI.lightLoopTaskUpdated),
        description: i18n._(PI.lightLoopTaskUpdatedDesc),
      })
      dialog.close()
    } catch (error) {
      showToast({
        type: "error",
        title: i18n._(PI.lightLoopTaskUpdateFailed),
        description: requestErrorMessage(error),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog title={i18n._(PI.lightLoopTaskDialogTitle)} size="form">
      <div data-slot="dialog-form">
        <TextField
          label={i18n._(PI.lightLoopTaskLabel)}
          value={taskDescription()}
          onChange={setTaskDescription}
          multiline
          rows={7}
          autofocus={state().mode === "editable"}
          readOnly={state().mode === "readOnly"}
          description={stateDescription()}
        />
        <div data-slot="dialog-actions">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
            {state().mode === "editable" ? i18n._(PI.lightLoopTaskCancel) : i18n._(PI.lightLoopTaskClose)}
          </Button>
          <Show when={state().mode === "editable"}>
            <Button type="button" variant="primary" size="large" disabled={!canSave()} onClick={save}>
              {saving() ? i18n._(PI.lightLoopTaskSaving) : i18n._(PI.lightLoopTaskSave)}
            </Button>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}
