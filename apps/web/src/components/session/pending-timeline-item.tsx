import { For, Show, createMemo, createSignal, onCleanup } from "solid-js"
import type { SessionInboxItem } from "@ericsanchezok/synergy-sdk"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { AttachmentGallery } from "@ericsanchezok/synergy-ui/attachment-card"
import { ResourceReferenceProvider } from "@ericsanchezok/synergy-ui/context/resource-open"
import { extractPromptDraft } from "@/utils/prompt"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useLocale } from "@/context/locale"
import { requestErrorMessage } from "@/utils/error"
import { pendingMessageText, pendingTimelineItemView } from "./conversation-pending"
import { S } from "./session-i18n"
import "./pending-composer-queue.css"

export function PendingTimelineItem(props: {
  item: SessionInboxItem
  rollbackActive: boolean
  hasCanonicalRoot: boolean
  serverUrl?: string
  onGuide?(item: SessionInboxItem): void | Promise<void>
  onRemove?(item: SessionInboxItem): void | Promise<void>
  onEdit?(item: SessionInboxItem): void | Promise<void>
}) {
  const { i18n } = useLocale()
  const _ = (d: { id: string; message: string }) => i18n._(d)
  const [pending, setPending] = createSignal(false)
  const [failure, setFailure] = createSignal<{ action: "guide" | "remove" | "edit"; error: unknown }>()
  let disposed = false
  onCleanup(() => {
    disposed = true
  })
  const attachments = createMemo(() => (props.item.message?.parts ?? []).filter((part) => part.type === "attachment"))
  const references = createMemo(() => {
    const draft = extractPromptDraft({ message: { metadata: props.item.message?.metadata }, parts: [] })
    return [
      ...draft.prompt.flatMap((part) => (part.type === "note" || part.type === "session" ? [part.title] : [])),
      ...draft.context.items.map((item) => item.path),
    ]
  })
  const view = () =>
    pendingTimelineItemView(props.item.mode, props.rollbackActive, {
      hasCanonicalRoot: props.hasCanonicalRoot,
      status: props.item.status,
    })
  const label = () =>
    pendingMessageText(props.item) || props.item.summary?.preview || props.item.summary?.title || _(S.convPending)
  const canEdit = () => view().canWithdraw && !!props.item.message && !!props.onEdit
  const run = async (action: "guide" | "remove" | "edit") => {
    if (
      pending() ||
      (action === "edit" ? !canEdit() : action === "remove" ? !view().canWithdraw : !view().primaryAction)
    )
      return
    setPending(true)
    setFailure(undefined)
    try {
      if (action === "edit") await props.onEdit?.(props.item)
      else if (action === "remove") await props.onRemove?.(props.item)
      else await props.onGuide?.(props.item)
    } catch (error) {
      if (!disposed) setFailure({ action, error })
    } finally {
      if (!disposed) setPending(false)
    }
  }
  return (
    <div
      data-slot="pending-timeline-item"
      data-mode={props.item.mode}
      data-frozen={view().frozen}
      class="flex w-full flex-col text-sm text-text-weak"
    >
      <div class="pending-composer-row">
        <span
          class="pending-composer-status"
          title={props.rollbackActive ? _(S.convPausedTooltip) : props.item.failReason}
        >
          <Show
            when={pending()}
            fallback={
              <Icon name={getSemanticIcon(props.item.mode === "steer" ? "inbox.steer" : "inbox.task")} size="small" />
            }
          >
            <Spinner class="size-4!" />
          </Show>
          <span classList={{ "sr-only": !view().frozen && props.item.status !== "failed" }}>
            {_(
              props.rollbackActive
                ? S.convPaused
                : props.item.status === "failed"
                  ? S.inboxFailedStatus
                  : S.convPending,
            )}
          </span>
        </span>
        <div class="pending-composer-label" title={label()}>
          {label()}
        </div>
        <div class="pending-composer-actions" aria-busy={pending()}>
          <Show when={view().primaryAction}>
            {(action) => (
              <Tooltip value={action() === "queue" ? _(S.convMoveToQueueTitle) : _(S.convGuideRunTitle)}>
                <Button
                  variant="ghost"
                  disabled={pending()}
                  aria-label={action() === "queue" ? _(S.convQueue) : _(S.convGuide)}
                  onClick={() => void run("guide")}
                >
                  <Icon name={getSemanticIcon(action() === "queue" ? "inbox.task" : "inbox.steer")} size="small" />
                </Button>
              </Tooltip>
            )}
          </Show>
          <Show when={canEdit()}>
            <Tooltip value={_(S.convEditPending)}>
              <Button
                variant="ghost"
                disabled={pending()}
                aria-label={_(S.convEditPending)}
                onClick={() => void run("edit")}
              >
                <Icon name={getSemanticIcon("action.edit")} size="small" />
              </Button>
            </Tooltip>
          </Show>
          <Show when={view().canWithdraw}>
            <Tooltip value={_(S.inboxDelete)}>
              <Button
                variant="ghost"
                disabled={pending()}
                aria-label={_(S.inboxDelete)}
                onClick={() => void run("remove")}
              >
                <Icon name={getSemanticIcon("action.remove")} size="small" />
              </Button>
            </Tooltip>
          </Show>
        </div>
      </div>
      <Show when={attachments().length}>
        <ResourceReferenceProvider value={props.item.message?.referenceContext}>
          <div class="pending-composer-attachments">
            <AttachmentGallery files={attachments()} serverUrl={props.serverUrl ?? ""} layout="rows" compact="draft" />
          </div>
        </ResourceReferenceProvider>
      </Show>
      <Show when={references().length}>
        <div class="pending-composer-references">
          <For each={references()}>{(reference) => <span title={reference}>{reference}</span>}</For>
        </div>
      </Show>
      <span role="status" class="sr-only">
        {pending() ? _(S.inboxOperationPending) : ""}
      </span>
      <Show when={failure()}>
        {(failed) => (
          <div role="alert" class="flex flex-col gap-2 text-text-base">
            <span>
              {_(
                failed().action === "edit"
                  ? S.convEditPendingFailed
                  : failed().action === "remove"
                    ? S.inboxRemoveFailed
                    : S.inboxGuideFailed,
              )}
            </span>
            <Show when={failed().action === "edit" && canEdit()}>
              <Button variant="secondary" disabled={pending()} onClick={() => void run("edit")}>
                {_(S.convEditPending)}
              </Button>
            </Show>
            <Show when={failed().action === "remove" && view().canWithdraw}>
              <div>
                <Button variant="secondary" disabled={pending()} onClick={() => void run("remove")}>
                  {_(S.inboxRetryRemove)}
                </Button>
              </div>
            </Show>
            <details>
              <summary class="cursor-pointer">{_(S.transitionErrorDetails)}</summary>
              <pre class="whitespace-pre-wrap break-words max-h-32 overflow-auto">
                {requestErrorMessage(failed().error, _(S.inboxRequestFailed))}
              </pre>
            </details>
          </div>
        )}
      </Show>
    </div>
  )
}
