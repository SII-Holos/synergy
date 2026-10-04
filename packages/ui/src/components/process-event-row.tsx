import { createMemo } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { Message } from "@ericsanchezok/synergy-sdk/client"
import { useResourceOpen, type ActivityDetailTarget } from "../context/resource-open"
import { Icon } from "./icon"
import { getSemanticIcon } from "./semantic-icon"
import "./process-event-row.css"

export function ProcessEventRow(props: {
  message: Message
  kind?: "agent-delivery" | "compaction"
  label?: string
  running?: boolean
  failed?: boolean
}) {
  const { _ } = useLingui()
  const resource = useResourceOpen()
  const target = createMemo<ActivityDetailTarget>(() => ({
    kind: props.kind ?? "agent-delivery",
    sessionID: props.message.sessionID,
    messageID: props.message.id,
  }))
  const title = () =>
    props.label ??
    (props.message.role === "user" && props.message.origin?.type === "cortex"
      ? _({ id: "session.process.agentDelivery", message: "Subagent returned" })
      : _({ id: "session.process.agentMessage", message: "Agent message" }))
  const label = () =>
    title() + (props.message.role === "user" && props.message.origin?.label ? ` · ${props.message.origin.label}` : "")
  return (
    <div
      data-component="process-event-row"
      data-status={props.running ? "running" : props.failed ? "failed" : "complete"}
    >
      <button
        type="button"
        data-slot="process-event-trigger"
        aria-pressed={resource?.isActivityDetailSelected?.(target()) ?? false}
        aria-label={_({
          id: "session.process.viewEvent",
          message: "View details: {title}",
          values: { title: label() },
        })}
        onClick={() => resource?.openActivityDetail?.(target())}
      >
        <span data-slot="process-event-icon" aria-hidden="true" data-running={props.running ? "" : undefined}>
          <Icon
            name={getSemanticIcon(
              props.failed
                ? "state.error"
                : props.running
                  ? "session.running"
                  : props.kind === "compaction"
                    ? "settings.compaction"
                    : "cortex.main",
            )}
            size="small"
          />
        </span>
        <span data-slot="process-event-title">{label()}</span>
      </button>
    </div>
  )
}
