import { Show, createSignal } from "solid-js"
import type { SessionInboxItem } from "@ericsanchezok/synergy-sdk"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useLocale } from "@/context/locale"
import { requestErrorMessage } from "@/utils/error"
import { pendingTimelineItemView } from "./conversation-pending"
import { S } from "./session-i18n"

export function PendingTimelineItem(props: {
  item: SessionInboxItem
  rollbackActive: boolean
  hasCanonicalRoot: boolean
  onGuide?(item: SessionInboxItem): void | Promise<void>
  onRemove?(item: SessionInboxItem): void | Promise<void>
}) {
  const { i18n } = useLocale()
  const _ = (d: { id: string; message: string }) => i18n._(d)
  const [pending, setPending] = createSignal(false)
  const [failure, setFailure] = createSignal<{ action: "guide" | "remove"; error: unknown }>()
  const view = () =>
    pendingTimelineItemView(props.item.mode, props.rollbackActive, {
      hasCanonicalRoot: props.hasCanonicalRoot,
      status: props.item.status,
    })
  const label = () => {
    const part = props.item.message?.parts?.[0]
    return part?.type === "text" ? part.text : (props.item.summary?.title ?? _(S.convPending))
  }
  const run = async (action: "guide" | "remove") => {
    if (pending()) return
    setPending(true)
    setFailure(undefined)
    try {
      await (action === "remove" ? props.onRemove?.(props.item) : props.onGuide?.(props.item))
    } catch (error) {
      setFailure({ action, error })
    } finally {
      setPending(false)
    }
  }
  return (
    <div
      data-slot="pending-timeline-item"
      data-mode={props.item.mode}
      data-frozen={view().frozen}
      class="flex w-full flex-col gap-2 rounded-lg bg-background-weak px-3 py-2 text-sm text-text-weak"
    >
      <div class="flex items-center gap-2">
        <span
          class="inline-flex items-center gap-1 text-11-medium"
          title={props.rollbackActive ? _(S.convPausedTooltip) : props.item.failReason}
        >
          <Icon name={getSemanticIcon("agenda.main")} size="small" />
          {_(
            props.rollbackActive ? S.convPaused : props.item.status === "failed" ? S.inboxFailedStatus : S.convPending,
          )}
        </span>
        <div class="min-w-0 flex-1 text-14-regular line-clamp-2">{label()}</div>
        <div class="ml-auto flex shrink-0 items-center gap-1">
          <Show when={view().primaryAction}>
            {(action) => (
              <Button
                variant="ghost"
                disabled={pending()}
                title={action() === "queue" ? _(S.convMoveToQueueTitle) : _(S.convGuideRunTitle)}
                onClick={() => void run("guide")}
              >
                {action() === "queue" ? _(S.convQueue) : _(S.convGuide)}
              </Button>
            )}
          </Show>
          <Show when={view().canWithdraw}>
            <Button
              variant="ghost"
              disabled={pending()}
              title={_(S.convRemovePendingTitle)}
              onClick={() => void run("remove")}
            >
              {_(S.convWithdraw)}
            </Button>
          </Show>
        </div>
      </div>
      <Show when={pending()}>
        <div role="status">{_(S.inboxOperationPending)}</div>
      </Show>
      <Show when={failure()}>
        {(failed) => (
          <div role="alert" class="flex flex-col gap-2 text-text-base">
            <span>{_(failed().action === "remove" ? S.inboxRemoveFailed : S.inboxGuideFailed)}</span>
            <Show when={failed().action === "remove"}>
              <div>
                <Button variant="secondary" onClick={() => void run("remove")}>
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
