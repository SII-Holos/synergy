import { Show, For, createMemo, createSignal, type Component } from "solid-js"
import { DateTime } from "luxon"
import type { MessagePartProps } from "./message-part"
import { Markdown } from "./markdown"
import { Icon } from "./icon"
import { getSemanticIcon } from "./semantic-icon"

import "./compaction-card.css"

interface CompactionRecoverySection {
  heading: string
  items: string[]
}

interface CompactionRecoveryPayload {
  type: string
  summary: string
  sections: CompactionRecoverySection[]
  mechanical: boolean
  recoverySessionIDs?: string[]
  pendingDagCount?: number
  nextStep?: string
  validated: boolean
}

function asCompactionRecovery(part: MessagePartProps["part"]): CompactionRecoveryPayload | null {
  if ((part as unknown as CompactionRecoveryPayload).type !== "compaction_recovery") return null
  return part as unknown as CompactionRecoveryPayload
}

const CompactionCard: Component<MessagePartProps> = (props) => {
  const match = createMemo(() => asCompactionRecovery(props.part))

  const [expanded, setExpanded] = createSignal(props.defaultOpen ?? false)

  const timestamp = createMemo(() => {
    const ms = props.message.time.created
    return DateTime.fromMillis(ms).toFormat("HH:mm")
  })

  const expandIcon = createMemo(() =>
    expanded() ? getSemanticIcon("navigation.collapse") : getSemanticIcon("navigation.expand"),
  )

  return (
    <Show when={match()}>
      {(p) => (
        <div data-component="compaction-card" data-expanded={expanded() ? "" : undefined}>
          <button type="button" data-slot="compaction-card-header" onClick={() => setExpanded((v) => !v)}>
            <div data-slot="compaction-card-header-left">
              <Icon name={getSemanticIcon("settings.compaction")} size="small" />
              <span data-slot="compaction-card-title">Session Compacted</span>
              <Show when={(p().pendingDagCount ?? 0) > 0}>
                <span data-slot="compaction-card-badge">{p().pendingDagCount} pending</span>
              </Show>
            </div>
            <div data-slot="compaction-card-header-right">
              <span data-slot="compaction-card-time">{timestamp()}</span>
              <div data-slot="compaction-card-arrow">
                <Icon name={expandIcon()} size="small" />
              </div>
            </div>
          </button>

          <Show when={expanded()}>
            <div data-slot="compaction-card-content">
              <Show when={p().mechanical}>
                <div data-slot="compaction-card-warning">
                  <Icon name="alert-triangle" size="small" />
                  <span data-slot="compaction-card-warning-text">
                    This summary was mechanically generated due to context limits. Some detail may be missing.
                  </span>
                </div>
              </Show>

              <div data-slot="compaction-card-summary">
                <Markdown text={p().summary} />
              </div>

              <For each={p().sections}>
                {(section) => (
                  <div data-slot="compaction-card-section">
                    <h4 data-slot="compaction-card-section-heading">{section.heading}</h4>
                    <For each={section.items}>
                      {(item) => (
                        <div data-slot="compaction-card-section-item">
                          <span data-slot="compaction-card-bullet">•</span>
                          <div data-slot="compaction-card-section-item-text">
                            <Markdown text={item} />
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                )}
              </For>

              <Show when={p().nextStep}>
                <div data-slot="compaction-card-next-step">
                  <Icon name={getSemanticIcon("action.info")} size="small" />
                  <div data-slot="compaction-card-next-step-content">
                    <span data-slot="compaction-card-next-step-label">Next step</span>
                    <span data-slot="compaction-card-next-step-text">{p().nextStep}</span>
                  </div>
                </div>
              </Show>
            </div>
          </Show>
        </div>
      )}
    </Show>
  )
}

export { CompactionCard }
