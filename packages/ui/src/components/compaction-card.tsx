import { Show, createMemo, createSignal, type Component } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { AssistantMessage, Message as MessageType, Part as PartType } from "@ericsanchezok/synergy-sdk/client"
import { Markdown } from "./markdown"
import { Icon } from "./icon"
import { createCopyController } from "./clipboard"
import { getSemanticIcon } from "./semantic-icon"
import { Collapsible } from "./collapsible"
import {
  COMPACTION_CARD_DESC,
  resolveCompactionCardPresentation,
  type CompactionAttemptState,
} from "./compaction-card-model"

import "./compaction-card.css"
import { messageCreatedTime } from "./message-time"

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
const compactionMechanicalWarningDescriptor = {
  id: "ui.compaction.mechanicalWarning",
  message: "This summary was mechanically generated due to context limits. Some detail may be missing.",
}
const compactionErrorDetailsDescriptor = { id: "ui.compaction.errorDetails", message: "Error details" }
const compactionCopyDetailsDescriptor = { id: "ui.compaction.copyDetails", message: "Copy details" }
const compactionCopiedDescriptor = { id: "ui.compaction.copied", message: "Copied" }
const compactionCopyFailureDescriptor = {
  id: "ui.compaction.copyFailure",
  message: "Unable to copy the compaction error details.",
}

function attemptState(message: AssistantMessage): CompactionAttemptState | undefined {
  const value = message.metadata?.compactionAttempt as { state?: unknown } | undefined
  if (!value || typeof value.state !== "string") return undefined
  if (["running", "committed", "failed", "empty"].includes(value.state)) {
    return value.state as CompactionAttemptState
  }
}

const CompactionCard: Component<CompactionCardProps> = (props) => {
  const { _ } = useLingui()
  const assistant = createMemo<AssistantMessage | undefined>(() => {
    const message = props.message
    return message.role === "assistant" ? message : undefined
  })
  const recovery = createMemo(() => asCompactionRecovery(props.part))
  const summary = createMemo(() => recovery()?.summary?.trim() ?? "")
  const presentation = createMemo(() => {
    const message = assistant()
    return resolveCompactionCardPresentation({
      attemptState: message ? attemptState(message) : undefined,
      error: message?.error,
      hasRecovery: recovery() !== undefined,
      messageCompleted: message?.time.completed != null,
      hasSummary: summary().length > 0,
    })
  })
  const copy = createCopyController({
    text: () => presentation().error,
    get copyLabel() {
      return _(compactionCopyDetailsDescriptor)
    },
    get copiedLabel() {
      return _(compactionCopiedDescriptor)
    },
    get failureDescription() {
      return _(compactionCopyFailureDescriptor)
    },
    copyIcon: getSemanticIcon("action.copy"),
    copiedIcon: getSemanticIcon("state.success"),
    failedIcon: getSemanticIcon("state.error"),
  })

  const [expanded, setExpanded] = createSignal(props.defaultOpen ?? false)

  const timestamp = createMemo(() => messageCreatedTime(props.message.time.created))
  const title = createMemo(() => {
    if (presentation().status === "failed") return _(COMPACTION_CARD_DESC.failedTitle)
    if (presentation().status === "running") return _(COMPACTION_CARD_DESC.runningTitle)
    return _(COMPACTION_CARD_DESC.completeTitle)
  })
  const description = createMemo(() => {
    const current = presentation()
    if (current.status === "failed") {
      return typeof current.description === "string" ? current.description : _(COMPACTION_CARD_DESC.failedDescription)
    }
    if (current.status === "running") return _(COMPACTION_CARD_DESC.preparingDescription)
    return _(COMPACTION_CARD_DESC.summaryReadyDescription)
  })
  const cardIcon = createMemo(() =>
    presentation().status === "failed" ? getSemanticIcon("state.error") : getSemanticIcon("settings.compaction"),
  )
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
              <Icon name={cardIcon()} size="small" />
            </div>
            <div data-slot="compaction-card-copy">
              <div data-slot="compaction-card-title-row">
                <span data-slot="compaction-card-title">{title()}</span>
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
        </Collapsible.Trigger>

        <Show when={canExpand()}>
          <Collapsible.Content>
            <div data-slot="compaction-card-content">
              <Show when={presentation().status === "failed" && presentation().error}>
                <div data-slot="compaction-card-error">
                  <div data-slot="compaction-card-error-label">{_(compactionErrorDetailsDescriptor)}</div>
                  <pre data-slot="compaction-card-error-text">{presentation().error}</pre>
                  <div data-slot="compaction-card-error-actions">
                    <button
                      type="button"
                      data-slot="compaction-card-copy-button"
                      data-copy-state={copy.state()}
                      disabled={copy.disabled()}
                      aria-label={copy.tooltip()}
                      onClick={() => void copy.copy()}
                    >
                      <Icon name={copy.icon()} size="small" />
                      <span>{copy.tooltip()}</span>
                    </button>
                  </div>
                </div>
              </Show>
              <Show when={recovery()}>
                {(p) => (
                  <>
                    <Show when={p().mechanical}>
                      <div data-slot="compaction-card-warning">
                        <Icon name={getSemanticIcon("state.warning")} size="small" />
                        <span data-slot="compaction-card-warning-text">{_(compactionMechanicalWarningDescriptor)}</span>
                      </div>
                    </Show>
                    <Show when={summary()}>
                      <div data-slot="compaction-card-summary">
                        <Markdown text={summary()} />
                      </div>
                    </Show>
                  </>
                )}
              </Show>
            </div>
          </Collapsible.Content>
        </Show>
      </Collapsible>
    </div>
  )
}

export { CompactionCard }
