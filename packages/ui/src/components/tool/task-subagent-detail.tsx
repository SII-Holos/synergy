import { useLingui } from "@lingui/solid"
import type { MessageDescriptor } from "@lingui/core"
import { createMemo, For, Show } from "solid-js"
import { useData } from "../../context"
import { Icon } from "../icon"
import { getSemanticIcon } from "../semantic-icon"
import { Spinner } from "../spinner"
import { TOOL_MISC_DESC, TOOL_TASK_DESC } from "../tool-title-descriptors"
import { getToolInfo } from "../message-part"
import { parseTaskSubagentSummary, type TaskSubagentSummaryItem } from "./task-info"

export type TaskSubagentDetailInfo = {
  agentType?: string
  description?: string
  background: boolean
  sessionId?: string
  summary: unknown
  running: boolean
  waitingApproval?: boolean
  error?: string
}

function resolveTitle(title: string | MessageDescriptor, translate: (descriptor: MessageDescriptor) => string): string {
  return typeof title === "string" ? title : translate(title)
}

function TaskSubagentStep(props: { item: TaskSubagentSummaryItem }) {
  const { _ } = useLingui()
  const info = getToolInfo(props.item.tool)
  const running = () =>
    props.item.state.status === "running" ||
    props.item.state.status === "pending" ||
    props.item.state.status === "generating"
  return (
    <li data-slot="task-tool-item" data-state={running() ? "running" : props.item.state.status}>
      <Icon name={info.icon} size="small" />
      <span data-slot="task-tool-title">{resolveTitle(info.title, _)}</span>
      <Show
        when={!running()}
        fallback={
          <span data-slot="task-tool-status">
            <Spinner />
          </span>
        }
      >
        <Show when={props.item.state.title}>{(title) => <span data-slot="task-tool-subtitle">{title()}</span>}</Show>
      </Show>
    </li>
  )
}

export function TaskSubagentSteps(props: { summary: unknown }) {
  const steps = createMemo(() => parseTaskSubagentSummary(props.summary))
  return (
    <ul data-component="task-tools">
      <For each={steps()}>{(item) => <TaskSubagentStep item={item} />}</For>
    </ul>
  )
}

export function TaskSubagentDetail(props: { info: TaskSubagentDetailInfo }) {
  const { _ } = useLingui()
  const data = useData()
  const steps = createMemo(() => parseTaskSubagentSummary(props.info.summary))
  const canOpenSession = () => props.info.sessionId !== undefined && data.navigateToSession !== undefined

  const openSession = () => {
    if (props.info.sessionId) data.navigateToSession?.(props.info.sessionId)
  }

  const emptyLabel = createMemo(() =>
    _(
      props.info.waitingApproval
        ? TOOL_TASK_DESC.waitingApproval
        : props.info.background
          ? TOOL_TASK_DESC.backgroundRunning
          : TOOL_TASK_DESC.starting,
    ),
  )

  return (
    <div data-component="tool-output" data-scrollable>
      <div data-component="task-subagent-detail">
        <div data-slot="task-subagent-header">
          <Show when={props.info.agentType}>
            {(agentType) => <span data-slot="task-subagent-agent">{agentType()}</span>}
          </Show>
          <Show when={props.info.background}>
            <span data-slot="task-subagent-background">{_(TOOL_MISC_DESC.backgroundTask)}</span>
          </Show>
        </div>
        <Show when={props.info.description}>
          {(description) => <p data-slot="task-subagent-description">{description()}</p>}
        </Show>
        <Show
          when={steps().length > 0}
          fallback={
            <Show when={!props.info.error}>
              <div data-slot="task-subagent-empty">
                <Show when={props.info.running} fallback={<span>{_(TOOL_TASK_DESC.noSteps)}</span>}>
                  <span data-slot="task-subagent-status">
                    <Spinner />
                  </span>
                  <span>{emptyLabel()}</span>
                </Show>
              </div>
            </Show>
          }
        >
          <TaskSubagentSteps summary={props.info.summary} />
        </Show>
        <Show when={props.info.error}>{(error) => <p data-slot="task-subagent-error">{error()}</p>}</Show>
        <Show when={canOpenSession()}>
          <button data-slot="task-subagent-open" type="button" onClick={openSession}>
            <Icon name={getSemanticIcon("action.open")} size="small" />
            <span>{_(TOOL_TASK_DESC.openSession)}</span>
          </button>
        </Show>
      </div>
    </div>
  )
}
