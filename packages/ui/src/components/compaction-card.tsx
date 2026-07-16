import { Show, createMemo, createSignal, type Component } from "solid-js"
import { DateTime } from "luxon"
import type { Message as MessageType, Part as PartType } from "@ericsanchezok/synergy-sdk/client"
import { Markdown } from "./markdown"
import { Icon } from "./icon"
import { getSemanticIcon } from "./semantic-icon"
import { Collapsible } from "./collapsible"
import { resolveCompactionCardPresentation } from "./compaction-card-model"

import "./compaction-card.css"

interface CompactionRecoveryPayload {
  type: string
  summary: string
  mechanical: boolean
  recoverySessionIDs?: string[]
  validated: boolean
}

export interface CompactionCardProps {
  part?: PartType
  message: MessageType
  defaultOpen?: boolean
}

function asCompactionRecovery(part: PartType | undefined): CompactionRecoveryPayload | undefined {
  if (!part) return undefined
  if ((part as unknown as CompactionRecoveryPayload).type !== "compaction_recovery") return undefined
  return part as unknown as CompactionRecoveryPayload
}

const CompactionCard: Component<CompactionCardProps> = (props) => {
  const recovery = createMemo(() => asCompactionRecovery(props.part))
  const summary = createMemo(() => recovery()?.summary?.trim() ?? "")
  const presentation = createMemo(() =>
    resolveCompactionCardPresentation({
      hasRecovery: recovery() !== undefined,
      messageCompleted: "completed" in props.message.time && props.message.time.completed != null,
      hasSummary: summary().length > 0,
    }),
  )

  const [expanded, setExpanded] = createSignal(props.defaultOpen ?? false)

  const timestamp = createMemo(() => DateTime.fromMillis(props.message.time.created).toFormat("HH:mm"))
  const canExpand = createMemo(() => presentation().canExpand)
  const open = createMemo(() => canExpand() && expanded())
  const expandIcon = createMemo(() =>
    open() ? getSemanticIcon("navigation.collapse") : getSemanticIcon("navigation.expand"),
  )

  const handleOpenChange = (value: boolean) => {
    if (!canExpand()) return
    setExpanded(value)
  }

  return (
    <div data-component="compaction-card" data-status={presentation().status} data-expanded={open() ? "" : undefined}>
      <Collapsible open={open()} onOpenChange={handleOpenChange} disabled={!canExpand()} variant="ghost">
        <Collapsible.Trigger data-slot="compaction-card-header" type="button">
          <div data-slot="compaction-card-leading">
            <div data-slot="compaction-card-icon" aria-hidden="true">
              <Icon name={getSemanticIcon("settings.compaction")} size="small" />
            </div>
            <div data-slot="compaction-card-copy">
              <div data-slot="compaction-card-title-row">
                <span data-slot="compaction-card-title">{presentation().title}</span>
              </div>
              <span data-slot="compaction-card-description">{presentation().description}</span>
            </div>
          </div>
          <div data-slot="compaction-card-meta">
            <span data-slot="compaction-card-time">{timestamp()}</span>
            <Show when={canExpand()}>
              <span data-slot="compaction-card-arrow" aria-hidden="true">
                <Icon name={expandIcon()} size="small" />
              </span>
            </Show>
          </div>
        </Collapsible.Trigger>

        <Show when={recovery()}>
          {(p) => (
            <Collapsible.Content>
              <div data-slot="compaction-card-content">
                <Show when={p().mechanical}>
                  <div data-slot="compaction-card-warning">
                    <Icon name={getSemanticIcon("state.warning")} size="small" />
                    <span data-slot="compaction-card-warning-text">
                      This summary was mechanically generated due to context limits. Some detail may be missing.
                    </span>
                  </div>
                </Show>

                <Show when={summary()}>
                  <div data-slot="compaction-card-summary">
                    <Markdown text={summary()} />
                  </div>
                </Show>
              </div>
            </Collapsible.Content>
          )}
        </Show>
      </Collapsible>
    </div>
  )
}

export { CompactionCard }
