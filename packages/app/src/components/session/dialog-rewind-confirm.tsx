import { createMemo, createSignal, Show } from "solid-js"
import type { UserMessage, Part as PartType } from "@ericsanchezok/synergy-sdk"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { showToast } from "@ericsanchezok/synergy-ui/toast"

interface DialogRewindConfirmProps {
  /** The target user message to rewind to (cut = this message and everything after) */
  cutMessage: UserMessage
  /** All messages in the session ordered by id */
  allMessages: { id: string; role: string }[]
  /** Parts records keyed by message id */
  partsByMessage: Record<string, PartType[] | undefined>
  onRewind: (cutMessageID: string, restoreFiles: boolean) => Promise<void>
}

function activeMessageIndex(messages: { id: string }[], cutId: string) {
  return messages.findIndex((m) => m.id >= cutId)
}

function computeCounts(props: {
  allMessages: { id: string; role: string }[]
  cutId: string
  partsByMessage: Record<string, PartType[] | undefined>
}) {
  const { allMessages, cutId, partsByMessage } = props
  const idx = activeMessageIndex(allMessages, cutId)
  if (idx < 0)
    return { droppedUserMessages: 0, assistantReplies: 0, affectedFiles: 0, affectedFileNames: [] as string[] }

  const dropped = allMessages.slice(idx)
  const droppedUser = dropped.filter((m) => m.role === "user")
  const assistantReplies = dropped.filter((m) => m.role === "assistant").length

  const affectedFileSet = new Set<string>()
  for (const m of dropped) {
    const parts = partsByMessage[m.id]
    if (parts) {
      for (const p of parts) {
        if (p.type === "patch" && "files" in p && Array.isArray((p as { files: string[] }).files)) {
          for (const f of (p as { files: string[] }).files) affectedFileSet.add(f)
        }
      }
    }
  }

  return {
    droppedUserMessages: droppedUser.length,
    assistantReplies,
    affectedFiles: affectedFileSet.size,
    affectedFileNames: Array.from(affectedFileSet).slice(0, 10),
  }
}

export function DialogRewindConfirm(props: DialogRewindConfirmProps) {
  const dialog = useDialog()
  const [pending, setPending] = createSignal(false)
  const [restoreFiles, setRestoreFiles] = createSignal(true)

  const summary = createMemo(() => (props.cutMessage as { summary?: { title?: string } }).summary?.title)

  const counts = createMemo(() =>
    computeCounts({
      allMessages: props.allMessages,
      cutId: props.cutMessage.id,
      partsByMessage: props.partsByMessage,
    }),
  )

  const handleRewind = async () => {
    if (pending()) return
    setPending(true)
    try {
      await props.onRewind(props.cutMessage.id, restoreFiles())
      dialog.close()
    } catch (error) {
      showToast({
        type: "error",
        title: "Rewind failed",
        description: error instanceof Error ? error.message : "Request failed",
      })
      setPending(false)
    }
  }

  return (
    <Dialog
      title="Rewind to here"
      description={
        summary() ? `Rewind before 「${summary()}」?` : "Rewind before this message? Messages after it will be hidden."
      }
      class="rewind-confirm-dialog"
      action={
        <button
          type="button"
          data-slot="dialog-close-button"
          data-component="icon-button"
          data-variant="ghost"
          disabled={pending()}
          onClick={() => {
            if (!pending()) dialog.close()
          }}
        >
          <Icon name="x" size="small" />
        </button>
      }
    >
      <div class="rewind-confirm-counts">
        <Show when={counts().droppedUserMessages > 0}>
          <div class="rewind-confirm-count-row">
            <Icon name="message-square" size="small" />
            <span>
              {counts().droppedUserMessages} user {counts().droppedUserMessages === 1 ? "message" : "messages"}
            </span>
          </div>
        </Show>
        <Show when={counts().assistantReplies > 0}>
          <div class="rewind-confirm-count-row">
            <Icon name="bot" size="small" />
            <span>
              {counts().assistantReplies} {counts().assistantReplies === 1 ? "reply" : "replies"}
            </span>
          </div>
        </Show>
        <Show when={counts().affectedFiles > 0}>
          <div class="rewind-confirm-count-row">
            <Icon name="file" size="small" />
            <span>
              {counts().affectedFiles} affected {counts().affectedFiles === 1 ? "file" : "files"}
            </span>
          </div>
          <Show when={counts().affectedFileNames.length > 0}>
            <div class="rewind-confirm-file-list">
              {counts().affectedFileNames.map((f) => (
                <span class="rewind-confirm-file-item">{f}</span>
              ))}
              <Show when={counts().affectedFiles > counts().affectedFileNames.length}>
                <span class="rewind-confirm-file-more">
                  +{counts().affectedFiles - counts().affectedFileNames.length} more
                </span>
              </Show>
            </div>
          </Show>
        </Show>
      </div>

      <label class="rewind-confirm-checkbox-label">
        <input
          type="checkbox"
          checked={restoreFiles()}
          onChange={(e) => setRestoreFiles(e.currentTarget.checked)}
          disabled={pending()}
        />
        <span>Restore files</span>
      </label>

      <div data-slot="dialog-actions" class="rewind-confirm-actions">
        <Button type="button" variant="ghost" size="large" disabled={pending()} onClick={() => dialog.close()}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="primary"
          size="large"
          class="rewind-confirm-button"
          data-tone="danger"
          disabled={pending()}
          onClick={() => void handleRewind()}
        >
          {pending() ? (
            <>
              <Spinner class="rewind-confirm-spinner" />
              {"Rewinding\u2026"}
            </>
          ) : (
            "Rewind"
          )}
        </Button>
      </div>
    </Dialog>
  )
}
