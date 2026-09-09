import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { useLocale } from "@/context/locale"
import "./dialog-fork-confirm.css"
import { S } from "./session-i18n"
import { computeForkCounts, copiedSummaryKind, type ForkConfirmMessage } from "./dialog-fork-confirm-model"
export { forkReplyPreview } from "./dialog-fork-confirm-model"

interface DialogForkConfirmProps {
  message: ForkConfirmMessage
  /** All user/assistant messages in canonical order */
  allMessages: { id: string; role: string }[]
  /** Whether the loaded window covers the complete effective history */
  hasCompleteHistory: boolean
  /** Short text preview of the target reply, when available */
  preview?: string
  /** Returns true when the fork succeeded and the dialog can close. */
  onConfirm: () => Promise<boolean>
}

export function DialogForkConfirm(props: DialogForkConfirmProps) {
  const { i18n, fmt } = useLocale()
  const dialog = useDialog()
  const _ = (d: { id: string; message: string }) => i18n._(d)
  const [state, setState] = createStore({ pending: false })

  const counts = createMemo(() => computeForkCounts(props.allMessages, props.message.id))

  const summaryText = createMemo(() => {
    const c = counts()
    const kind = props.hasCompleteHistory ? copiedSummaryKind(c) : "other"
    return i18n._({
      ...S.forkConfirmCopiedSummary,
      values: {
        kind,
        messages: c.userMessages,
        replies: c.assistantReplies,
      },
    })
  })

  const description = createMemo(() => {
    const preview = props.preview?.trim()
    if (preview) return i18n._({ ...S.forkConfirmDescriptionPreview, values: { preview } })
    return _(S.forkConfirmDescription)
  })

  const forkedAt = createMemo(() => {
    const time = props.message.time?.completed ?? props.message.time?.created
    return time ? fmt.time(time) : undefined
  })

  const handleConfirm = async () => {
    if (state.pending) return
    setState("pending", true)
    try {
      const ok = await props.onConfirm()
      if (ok) dialog.close()
      else setState("pending", false)
    } catch (error) {
      showToast({
        type: "error",
        title: _(S.forkConfirmFailed),
        description: error instanceof Error ? error.message : _(S.forkConfirmRequestFailed),
      })
      setState("pending", false)
    }
  }

  return (
    <Dialog
      title={_(S.forkConfirmTitle)}
      description={description()}
      size="compact"
      class="fork-confirm-dialog"
      dismissible={!state.pending}
      action={
        <button
          type="button"
          data-slot="dialog-close-button"
          data-component="icon-button"
          data-variant="ghost"
          aria-label={_(S.forkConfirmClose)}
          disabled={state.pending}
          onClick={() => {
            if (!state.pending) dialog.close()
          }}
        >
          <Icon name={getSemanticIcon("action.close")} size="small" />
        </button>
      }
    >
      <div class="fork-confirm-impact">
        <span class="fork-confirm-impact-value">{summaryText()}</span>
        <span class="fork-confirm-impact-note">
          {i18n._({ ...S.forkConfirmCopiedNote, values: { time: forkedAt() ?? "\u2014" } })}
        </span>
      </div>
      <div data-slot="dialog-actions" class="fork-confirm-actions">
        <Button type="button" variant="ghost" size="large" disabled={state.pending} onClick={() => dialog.close()}>
          {_(S.forkConfirmCancel)}
        </Button>
        <Button
          type="button"
          variant="primary"
          size="large"
          class="fork-confirm-button"
          disabled={state.pending}
          onClick={() => void handleConfirm()}
        >
          {state.pending ? (
            <>
              <Spinner class="fork-confirm-spinner" />
              {_(S.forkConfirmForking)}
            </>
          ) : (
            _(S.forkConfirmAction)
          )}
        </Button>
      </div>
    </Dialog>
  )
}
