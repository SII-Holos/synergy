import { Show } from "solid-js"
import { Portal } from "solid-js/web"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import type { SessionRollbackSummary } from "@ericsanchezok/synergy-sdk/client"
import type { useSDK } from "@/context/sdk"
import { useLocale } from "@/context/locale"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { S } from "./session-i18n"

interface RollbackBannerProps {
  sessionID: string
  rollback: SessionRollbackSummary
  sdk: ReturnType<typeof useSDK>
  onDismiss: () => void
}

export function RollbackBanner(props: RollbackBannerProps) {
  const { i18n } = useLocale()
  const _ = (d: { id: string; message: string }) => i18n._(d)
  const { rollback } = props
  const numTurns = rollback.numTurns ?? 0
  const numMessages = rollback.droppedMessageIDs?.length ?? 0
  const numFiles = rollback.files?.length ?? 0

  const handleRedo = async () => {
    if (!rollback.canUnrollback) {
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
        description: i18n._({ ...S.rollbackRedoSuccessDesc, values: { count: numMessages } }),
      })
      props.onDismiss()
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
    if (numFiles === 0) return
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
    <Portal>
      <div data-component="rollback-banner">
        <div data-slot="rollback-banner-content">
          <Icon name={getSemanticIcon("session.rewind")} size="small" />
          <span data-slot="rollback-banner-text">
            {i18n._({ ...S.rollbackBannerText, values: { messages: numMessages, turns: numTurns } })}
          </span>
        </div>
        <div data-slot="rollback-banner-actions">
          <Button
            type="button"
            variant="ghost"
            size="small"
            data-tone={rollback.canUnrollback ? "neutral" : "disabled"}
            disabled={!rollback.canUnrollback}
            title={rollback.canUnrollback ? _(S.rollbackRestoreTooltip) : _(S.rollbackCannotRedoTooltip)}
            onClick={() => void handleRedo()}
          >
            {_(S.rollbackRedo)}
          </Button>
          <Show when={numFiles > 0}>
            <Button type="button" variant="ghost" size="small" onClick={() => void handleRestoreFiles()}>
              {i18n._({ ...S.rollbackRestoreFiles, values: { count: numFiles } })}
            </Button>
          </Show>
          <Button
            type="button"
            variant="ghost"
            size="small"
            class="rollback-banner-dismiss"
            onClick={props.onDismiss}
            aria-label={_(S.rollbackDismiss)}
          >
            <Icon name={getSemanticIcon("action.close")} size="small" />
          </Button>
        </div>
      </div>
    </Portal>
  )
}
