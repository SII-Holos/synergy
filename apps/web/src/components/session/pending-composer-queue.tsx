import { For, Show } from "solid-js"
import type { SessionInboxItem } from "@ericsanchezok/synergy-sdk"
import { useLocale } from "@/context/locale"
import { PendingTimelineItem } from "./pending-timeline-item"
import { S } from "./session-i18n"
import "./pending-composer-queue.css"

export function PendingComposerQueue(props: {
  identity: string
  items: readonly SessionInboxItem[]
  rollbackActive: boolean
  hasCanonicalRoot: boolean
  onGuide(item: SessionInboxItem): void | Promise<void>
  onRemove(item: SessionInboxItem): void | Promise<void>
}) {
  const { i18n } = useLocale()
  return (
    <Show when={props.identity} keyed>
      {(_identity) => (
        <Show when={props.items.length}>
          <section class="pending-composer-queue" aria-label={i18n._(S.inboxTitle)}>
            <div class="pending-composer-list">
              <For each={props.items.map((item) => item.id)}>
                {(id) => (
                  <PendingTimelineItem
                    item={props.items.find((item) => item.id === id)!}
                    rollbackActive={props.rollbackActive}
                    hasCanonicalRoot={props.hasCanonicalRoot}
                    onGuide={(item) => props.onGuide(item)}
                    onRemove={(item) => props.onRemove(item)}
                  />
                )}
              </For>
            </div>
          </section>
        </Show>
      )}
    </Show>
  )
}
