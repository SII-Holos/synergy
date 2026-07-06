import { Show } from "solid-js"
import { Portal } from "solid-js/web"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import type { SessionRollbackSummary } from "@ericsanchezok/synergy-sdk/client"
import type { useSDK } from "@/context/sdk"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"

interface RollbackBannerProps {
  sessionID: string
  rollback: SessionRollbackSummary
  sdk: ReturnType<typeof useSDK>
  onDismiss: () => void
}

export function RollbackBanner(props: RollbackBannerProps) {
  const { rollback } = props
  const numTurns = rollback.numTurns ?? 0
  const numMessages = rollback.droppedMessageIDs?.length ?? 0
  const numFiles = rollback.files?.length ?? 0

  const handleRedo = async () => {
    if (!rollback.canUnrollback) {
      showToast({
        type: "info",
        title: "Cannot redo",
        description: "A new task has been started. The rollback can no longer be redone.",
        duration: 4000,
      })
      return
    }

    try {
      await props.sdk.client.session.unrollback({ sessionID: props.sessionID })
      showToast({
        type: "success",
        title: "Redo complete",
        description: `Restored ${numMessages} message${numMessages === 1 ? "" : "s"}`,
      })
      props.onDismiss()
    } catch (err) {
      if (err instanceof Error && err.message?.includes("new session messages")) {
        showToast({
          type: "warning",
          title: "Cannot redo",
          description: "New messages have been added. This rollback can no longer be redone.",
        })
      } else {
        showToast({
          type: "error",
          title: "Redo failed",
          description: err instanceof Error ? err.message : "Request failed",
        })
      }
    }
  }

  const handleRestoreFiles = async () => {
    if (numFiles === 0) return
    try {
      const result = await props.sdk.client.session.files.restore({
        sessionID: props.sessionID,
        rollbackID: rollback.id,
      })
      const count = result.data?.restoredFiles?.length ?? 0
      showToast({
        type: "success",
        title: "Files restored",
        description: `${count} file${count === 1 ? "" : "s"} restored`,
      })
    } catch (err) {
      showToast({
        type: "error",
        title: "Failed to restore files",
        description: err instanceof Error ? err.message : "Request failed",
      })
    }
  }

  return (
    <Portal>
      <div data-component="rollback-banner">
        <div data-slot="rollback-banner-content">
          <Icon name={getSemanticIcon("session.rewind")} size="small" />
          <span data-slot="rollback-banner-text">
            Rewound {numMessages} message{numMessages === 1 ? "" : "s"} ({numTurns} turn{numTurns === 1 ? "" : "s"})
          </span>
        </div>
        <div data-slot="rollback-banner-actions">
          <Button
            type="button"
            variant="ghost"
            size="small"
            data-tone={rollback.canUnrollback ? "neutral" : "disabled"}
            disabled={!rollback.canUnrollback}
            title={
              rollback.canUnrollback
                ? "Restore the rewound messages"
                : "New messages have been added; cannot redo this rollback"
            }
            onClick={() => void handleRedo()}
          >
            Redo
          </Button>
          <Show when={numFiles > 0}>
            <Button type="button" variant="ghost" size="small" onClick={() => void handleRestoreFiles()}>
              Restore files ({numFiles})
            </Button>
          </Show>
          <Button
            type="button"
            variant="ghost"
            size="small"
            class="rollback-banner-dismiss"
            onClick={props.onDismiss}
            aria-label="Dismiss"
          >
            <Icon name={getSemanticIcon("action.close")} size="small" />
          </Button>
        </div>
      </div>
    </Portal>
  )
}
