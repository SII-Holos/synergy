import { createMemo, type Component } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { Message, Part } from "@ericsanchezok/synergy-sdk/client"
import {
  COMPACTION_CARD_DESC,
  resolveCompactionCardPresentation,
  type CompactionAttemptState,
} from "./compaction-card-model"
import { ProcessEventRow } from "./process-event-row"
export { compactionErrorText } from "./compaction-card-model"

export interface CompactionCardProps {
  part?: Part
  message: Message
}

export const CompactionCard: Component<CompactionCardProps> = (props) => {
  const { _ } = useLingui()
  const presentation = createMemo(() => {
    const message = props.message.role === "assistant" ? props.message : undefined
    const state = (message?.metadata?.compactionAttempt as { state?: CompactionAttemptState } | undefined)?.state
    const recovery = props.part?.type === "compaction_recovery" ? props.part : undefined
    return resolveCompactionCardPresentation({
      attemptState: state,
      error: message?.error,
      hasRecovery: !!recovery,
      messageCompleted: message?.time.completed != null,
      hasSummary: !!recovery?.summary,
    })
  })
  return (
    <div data-component="compaction-card" data-status={presentation().status}>
      <ProcessEventRow
        message={props.message}
        kind="compaction"
        label={
          presentation().status === "running"
            ? _(COMPACTION_CARD_DESC.runningTitle)
            : presentation().status === "failed"
              ? _(COMPACTION_CARD_DESC.failedTitle)
              : _(COMPACTION_CARD_DESC.completeTitle)
        }
        running={presentation().status === "running"}
        failed={presentation().status === "failed"}
      />
    </div>
  )
}
