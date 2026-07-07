import { createMemo, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { UserMessage, Part as PartType } from "@ericsanchezok/synergy-sdk"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import "./dialog-rewind-confirm.css"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"

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
  if (idx < 0) return { droppedUserMessages: 0, assistantReplies: 0, affectedFiles: 0 }

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
  }
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`
}

function joinParts(parts: string[]) {
  if (parts.length === 0) return "the conversation"
  if (parts.length === 1) return parts[0]
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`
}

function hiddenItemText(counts: ReturnType<typeof computeCounts>) {
  const parts: string[] = []
  if (counts.droppedUserMessages > 0) parts.push(pluralize(counts.droppedUserMessages, "message"))
  if (counts.assistantReplies > 0) parts.push(pluralize(counts.assistantReplies, "reply", "replies"))
  return joinParts(parts)
}

function fileChangeText(count: number) {
  return pluralize(count, "changed file")
}

function displaySummary(value: string | undefined) {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  if (trimmed.length <= 96) return trimmed
  return `${trimmed.slice(0, 95)}…`
}

export function DialogRewindConfirm(props: DialogRewindConfirmProps) {
  const dialog = useDialog()
  const [state, setState] = createStore({ pending: false, restoreFiles: false })

  const summary = createMemo(() =>
    displaySummary((props.cutMessage as { summary?: { title?: string } }).summary?.title),
  )

  const counts = createMemo(() =>
    computeCounts({
      allMessages: props.allMessages,
      cutId: props.cutMessage.id,
      partsByMessage: props.partsByMessage,
    }),
  )

  const description = createMemo(() => {
    const title = summary()
    if (title) return `Return to before “${title}”. Hidden work can be redone until you start a new task.`
    return "Return to before this message. Hidden work can be redone until you start a new task."
  })

  const confirmLabel = createMemo(() => (state.restoreFiles ? "Rewind and restore files" : "Rewind"))

  const handleRewind = async () => {
    if (state.pending) return
    setState("pending", true)
    try {
      await props.onRewind(props.cutMessage.id, state.restoreFiles)
      dialog.close()
    } catch (error) {
      showToast({
        type: "error",
        title: "Rewind failed",
        description: error instanceof Error ? error.message : "Request failed",
      })
      setState("pending", false)
    }
  }

  return (
    <Dialog
      title="Rewind to this point"
      description={description()}
      size="compact"
      class="rewind-confirm-dialog"
      action={
        <button
          type="button"
          data-slot="dialog-close-button"
          data-component="icon-button"
          data-variant="ghost"
          disabled={state.pending}
          onClick={() => {
            if (!state.pending) dialog.close()
          }}
        >
          <Icon name={getSemanticIcon("action.close")} size="small" />
        </button>
      }
    >
      <div class="rewind-confirm-impact">
        <span class="rewind-confirm-impact-label">This will hide</span>
        <span class="rewind-confirm-impact-value">{hiddenItemText(counts())} starting here.</span>
        <Show when={counts().affectedFiles > 0}>
          <span class="rewind-confirm-impact-note">
            {fileChangeText(counts().affectedFiles)} associated with the hidden work.
          </span>
        </Show>
      </div>

      <Show when={counts().affectedFiles > 0}>
        <div class="rewind-confirm-option-group">
          <div class="rewind-confirm-section-label">Optional</div>
          <label
            class="rewind-confirm-file-option"
            data-selected={state.restoreFiles ? "true" : "false"}
            data-disabled={state.pending ? "true" : "false"}
          >
            <input
              type="checkbox"
              checked={state.restoreFiles}
              onChange={(event) => setState("restoreFiles", event.currentTarget.checked)}
              disabled={state.pending}
            />
            <span class="rewind-confirm-file-option-copy">
              <span class="rewind-confirm-file-option-title">Also restore file changes</span>
              <span class="rewind-confirm-file-option-hint">
                Revert on-disk edits made after this point across {fileChangeText(counts().affectedFiles)}. If you leave
                this off, you can still restore files later from the banner.
              </span>
            </span>
          </label>
        </div>
      </Show>

      <div data-slot="dialog-actions" class="rewind-confirm-actions">
        <Button type="button" variant="ghost" size="large" disabled={state.pending} onClick={() => dialog.close()}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="primary"
          size="large"
          class="rewind-confirm-button"
          disabled={state.pending}
          onClick={() => void handleRewind()}
        >
          {state.pending ? (
            <>
              <Spinner class="rewind-confirm-spinner" />
              {"Rewinding…"}
            </>
          ) : (
            confirmLabel()
          )}
        </Button>
      </div>
    </Dialog>
  )
}
