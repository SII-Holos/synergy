import { createMemo, createResource, createSignal, onCleanup, Show } from "solid-js"
import type { ProjectDirectories, Session, SessionWorkspaceSelection } from "@ericsanchezok/synergy-sdk"
import { createStore } from "solid-js/store"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { RadioGroup } from "@ericsanchezok/synergy-ui/radio-group"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { useLocale } from "@/context/locale"
import "./dialog-fork-confirm.css"
import { S } from "./session-i18n"
import {
  computeForkCounts,
  copiedSummaryKind,
  forkWorkspaceChoices,
  type ForkConfirmMessage,
  type ForkWorkspaceChoice,
} from "./dialog-fork-confirm-model"
export { forkReplyPreview } from "./dialog-fork-confirm-model"

interface DialogForkConfirmProps {
  source: Pick<Session, "title" | "workspace">
  message?: ForkConfirmMessage
  /** All user/assistant messages in canonical order */
  allMessages: { id: string; role: string }[]
  /** Whether the loaded window covers the complete effective history */
  hasCompleteHistory: boolean
  /** Short text preview of the target reply, when available */
  preview?: string
  loadDirectories?: () => Promise<ProjectDirectories | undefined>
  /** Returns true when the fork succeeded and the dialog can close. */
  onConfirm: (workspace: SessionWorkspaceSelection) => Promise<boolean>
  onClose: () => void
}

export function DialogForkConfirm(props: DialogForkConfirmProps) {
  const { i18n, fmt } = useLocale()
  const _ = (d: { id: string; message: string }) => i18n._(d)
  const [state, setState] = createStore({ pending: false })
  const [directories, { refetch }] = createResource(async () => {
    try {
      return { data: await props.loadDirectories?.(), failed: false }
    } catch {
      return { data: undefined, failed: true }
    }
  })
  const [selected, setSelected] = createSignal<ForkWorkspaceChoice["id"]>()
  const choices = createMemo(() => forkWorkspaceChoices(props.source.workspace, directories.latest?.data))
  const choice = createMemo(() =>
    choices().find(
      (item) => item.id === (selected() ?? (choices().some((item) => item.id === "current") ? "current" : "main")),
    ),
  )
  const labels = createMemo(() => ({
    main: _(S.forkLocationMain),
    create: _(S.forkLocationCreate),
    worktree: _(S.forkLocationWorktree),
    workspace: _(S.forkLocationCurrent),
    none: _(S.forkLocationNone),
  }))
  let disposed = false
  onCleanup(() => {
    disposed = true
  })

  const counts = createMemo(() => computeForkCounts(props.allMessages, props.message?.id))

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
    if (!props.message) return _(S.forkConfirmDescriptionCurrent)
    const preview = props.preview?.trim()
    if (preview) return i18n._({ ...S.forkConfirmDescriptionPreview, values: { preview } })
    return _(S.forkConfirmDescription)
  })

  const forkedAt = createMemo(() => {
    const time = props.message?.time?.completed ?? props.message?.time?.created
    return time ? fmt.time(time) : undefined
  })

  const handleConfirm = async () => {
    const destination = choice()
    if (state.pending || directories.loading || directories.latest?.failed || !destination) return
    setState("pending", true)
    try {
      const ok = await props.onConfirm(destination.workspace)
      if (disposed) return
      if (ok) props.onClose()
      else setState("pending", false)
    } catch (error) {
      if (disposed) return
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
            if (!state.pending) props.onClose()
          }}
        >
          <Icon name={getSemanticIcon("action.close")} size="small" />
        </button>
      }
    >
      <div class="fork-confirm-impact">
        <span class="fork-confirm-impact-value">{props.source.title}</span>
        <span class="fork-confirm-impact-note">{summaryText()}</span>
        <Show when={forkedAt()}>
          <span class="fork-confirm-impact-note">
            {i18n._({ ...S.forkConfirmCopiedNote, values: { time: forkedAt() ?? "\u2014" } })}
          </span>
        </Show>
      </div>
      <div class="fork-confirm-location">
        <span class="fork-confirm-location-label">{_(S.forkLocationTitle)}</span>
        <Show
          when={!directories.loading}
          fallback={
            <span role="status" class="fork-confirm-impact-note">
              {_(S.forkLocationLoading)}
            </span>
          }
        >
          <Show
            when={!directories.latest?.failed}
            fallback={
              <div class="fork-confirm-location-error" role="alert">
                <span>{_(S.forkLocationFailed)}</span>
                <Button variant="secondary" onClick={() => void refetch()}>
                  {_(S.forkLocationRetry)}
                </Button>
              </div>
            }
          >
            <RadioGroup
              aria-label={_(S.forkLocationTitle)}
              orientation="vertical"
              options={choices()}
              current={choice()}
              value={(item) => item.id}
              label={(item) => labels()[item.kind]}
              onSelect={(item) => item && setSelected(item.id)}
              disabled={state.pending}
            />
            <Show when={choice()?.path}>
              {(path) => (
                <span class="fork-confirm-location-path" title={path()}>
                  {path()}
                </span>
              )}
            </Show>
          </Show>
        </Show>
      </div>
      <div data-slot="dialog-actions" class="fork-confirm-actions">
        <Button type="button" variant="ghost" size="large" disabled={state.pending} onClick={props.onClose}>
          {_(S.forkConfirmCancel)}
        </Button>
        <Button
          type="button"
          variant="primary"
          size="large"
          class="fork-confirm-button"
          disabled={state.pending || directories.loading || directories.latest?.failed || !choice()}
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
