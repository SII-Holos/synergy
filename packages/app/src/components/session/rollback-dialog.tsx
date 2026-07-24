import { Show, type Accessor } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import type { SessionRollbackSummary } from "@ericsanchezok/synergy-sdk/client"
import type { useSDK } from "@/context/sdk"
import { useLocale } from "@/context/locale"
import { S } from "./session-i18n"
import "./rollback-dialog.css"

interface RollbackDialogProps {
  sessionID: string
  rollback: Accessor<SessionRollbackSummary>
  sdk: ReturnType<typeof useSDK>
}

export function RollbackDialog(props: RollbackDialogProps) {
  const dialog = useDialog()
  const { i18n } = useLocale()
  const _ = (d: { id: string; message: string }) => i18n._(d)
  const numTurns = () => props.rollback().numTurns ?? 0
  const numMessages = () => props.rollback().droppedMessageIDs?.length ?? 0
  const numFiles = () => props.rollback().files?.length ?? 0

  const handleRedo = async () => {
    if (!props.rollback().canUnrollback) {
      showToast({
        type: "info",
        title: _(S.rollbackCannotRedo),
        description: _(S.rollbackCannotRedoDesc),
        duration: 4000,
      })
      return
    }

    try {
      await props.sdk.client.session.unrollback({ sessionID: props.sessionID })
      showToast({
        type: "success",
        title: _(S.rollbackRedoComplete),
        description: i18n._({ ...S.rollbackRedoSuccessDesc, values: { count: numMessages() } }),
      })
      dialog.close()
    } catch (err) {
      if (err instanceof Error && err.message?.includes("new session messages")) {
        showToast({ type: "warning", title: _(S.rollbackCannotRedo), description: _(S.rollbackCannotRedoNew) })
      } else {
        showToast({
          type: "error",
          title: _(S.rollbackRedoFailed),
          description: err instanceof Error ? err.message : _(S.rollbackRequestFailed),
        })
      }
    }
  }

  const handleRestoreFiles = async () => {
    const rollback = props.rollback()
    if (numFiles() === 0) return
    try {
      const result = await props.sdk.client.session.files.restore({
        sessionID: props.sessionID,
        rollbackID: rollback.id,
      })
      const count = result.data?.restoredFiles?.length ?? 0
      showToast({
        type: "success",
        title: _(S.rollbackFilesRestored),
        description: i18n._({ ...S.rollbackRestoreSuccessDesc, values: { count } }),
      })
    } catch (err) {
      showToast({
        type: "error",
        title: _(S.rollbackFilesRestoreFailed),
        description: err instanceof Error ? err.message : _(S.rollbackRequestFailed),
      })
    }
  }

  return (
    <Dialog
      title={_(S.rollbackComplete)}
      description={i18n._({
        ...S.rollbackSummary,
        values: { messages: numMessages(), turns: numTurns() },
      })}
      size="compact"
      class="rollback-dialog"
    >
      <div data-slot="dialog-actions" class="rollback-dialog-actions">
        <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
          {_(S.rollbackDismiss)}
        </Button>
        <Show when={numFiles() > 0}>
          <Button type="button" variant="ghost" size="large" onClick={() => void handleRestoreFiles()}>
            {i18n._({ ...S.rollbackRestoreFiles, values: { count: numFiles() } })}
          </Button>
        </Show>
        <Button
          type="button"
          variant="primary"
          size="large"
          disabled={!props.rollback().canUnrollback}
          title={props.rollback().canUnrollback ? _(S.rollbackRestoreTooltip) : _(S.rollbackCannotRedoTooltip)}
          onClick={() => void handleRedo()}
        >
          {_(S.rollbackRedo)}
        </Button>
      </div>
    </Dialog>
  )
}
