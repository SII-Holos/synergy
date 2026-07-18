import { For, Show } from "solid-js"
import type { SessionInboxItem } from "@ericsanchezok/synergy-sdk/client"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { pendingTimelineActions } from "./pending-timeline-item-model"
import { S } from "./session-i18n"

type SessionDescriptor = (typeof S)[keyof typeof S]

export function PendingTimelineItem(props: {
  item: SessionInboxItem
  rollbackActive: boolean
  translate: (descriptor: SessionDescriptor) => string
  onGuide?: (item: SessionInboxItem) => void
  onRemove?: (item: SessionInboxItem) => void
}) {
  const label = () =>
    props.item.message?.parts?.[0]?.type === "text"
      ? (props.item.message.parts[0] as { text: string }).text
      : (props.item.summary?.title ?? props.translate(S.convPending))
  const actions = () => pendingTimelineActions(props.item.mode)
  const actionIcon = (kind: "guide" | "queue" | "withdraw") => {
    if (kind === "guide") return getSemanticIcon("command.start")
    if (kind === "queue") return getSemanticIcon("prompt.submit")
    return getSemanticIcon("action.close")
  }

  return (
    <div
      data-slot="pending-timeline-item"
      data-mode={props.item.mode}
      data-frozen={props.rollbackActive}
      class="w-full flex items-center gap-4"
      style={{ animation: "fadeUp 0.3s ease-out both" }}
    >
      <div class="w-full px-3 md:px-1 max-w-[60rem] md:mx-auto flex items-center gap-6">
        <div class="w-full flex items-center gap-3 px-2 rounded-full">
          <Show when={props.rollbackActive}>
            <span
              class="inline-flex shrink-0 items-center gap-1 text-12-regular text-text-weak"
              title={props.translate(S.convPausedTooltip)}
            >
              <Icon name={getSemanticIcon("agenda.main")} size="small" />
              {props.translate(S.convPaused)}
            </span>
          </Show>
          <div class="w-full min-w-0 text-14-regular line-clamp-2 text-text-weak">{label()}</div>
          <div class="ml-auto flex shrink-0 items-center gap-1">
            <For each={actions()}>
              {(action) => (
                <button
                  type="button"
                  data-action={action.kind}
                  class="inline-flex h-7 items-center gap-1 rounded-md px-2 text-11-medium text-text-weak hover:bg-background-base hover:text-text-base"
                  title={props.translate(action.title)}
                  onClick={() =>
                    action.kind === "withdraw" ? props.onRemove?.(props.item) : props.onGuide?.(props.item)
                  }
                >
                  <Icon name={actionIcon(action.kind)} size="small" />
                  <span>{props.translate(action.label)}</span>
                </button>
              )}
            </For>
          </div>
        </div>
      </div>
    </div>
  )
}
