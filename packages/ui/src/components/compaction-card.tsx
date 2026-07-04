import { Show, createMemo, createSignal, type Component } from "solid-js"
import { DateTime } from "luxon"
import type { Message as MessageType, Part as PartType } from "@ericsanchezok/synergy-sdk/client"
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
  const complete = createMemo(() => recovery()?.validated === true)
  const summary = createMemo(() => recovery()?.summary?.trim() ?? "")

  const [expanded, setExpanded] = createSignal(props.defaultOpen ?? false)

  const timestamp = createMemo(() => DateTime.fromMillis(props.message.time.created).toFormat("HH:mm"))
  const title = createMemo(() => (complete() ? "Context compressed" : "Compressing context..."))
  const description = createMemo(() => (complete() ? "Summary ready" : "Preparing a compact continuation summary"))
  const canExpand = createMemo(() => complete() && (!!summary() || !!recovery()?.nextStep))
  const expandIcon = createMemo(() =>
    expanded() ? getSemanticIcon("navigation.collapse") : getSemanticIcon("navigation.expand"),
  )

  const toggle = () => {
    if (!canExpand()) return
    setExpanded((value) => !value)
  }

  return (
    <div
      data-component="compaction-card"
      data-status={complete() ? "complete" : "running"}
      data-expanded={expanded() ? "" : undefined}
    >
      <button
        type="button"
        data-slot="compaction-card-header"
        disabled={!canExpand()}
        aria-expanded={canExpand() ? expanded() : undefined}
        onClick={toggle}
      >
        <div data-slot="compaction-card-leading">
          <div data-slot="compaction-card-icon" aria-hidden="true">
            <Icon name={getSemanticIcon("settings.compaction")} size="small" />
          </div>
          <div data-slot="compaction-card-copy">
            <div data-slot="compaction-card-title-row">
              <span data-slot="compaction-card-title">{title()}</span>
              <Show when={(recovery()?.pendingDagCount ?? 0) > 0}>
                <span data-slot="compaction-card-badge">{recovery()!.pendingDagCount} pending</span>
              </Show>
            </div>
            <span data-slot="compaction-card-description">{description()}</span>
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
      </button>

      <Show when={expanded() && recovery()}>
        {(p) => (
          <div data-slot="compaction-card-content">
            <Show when={p().mechanical}>
              <div data-slot="compaction-card-warning">
                <Icon name="alert-triangle" size="small" />
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

            <Show when={p().nextStep}>
              {(nextStep) => (
                <div data-slot="compaction-card-next-step">
                  <span data-slot="compaction-card-next-step-label">Next step</span>
                  <span data-slot="compaction-card-next-step-text">{nextStep()}</span>
                </div>
              )}
            </Show>
          </div>
        )}
      </Show>
    </div>
  )
}

export { CompactionCard }
