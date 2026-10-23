import { createMemo, createResource, onCleanup, Show, Switch, Match } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { MessageDescriptor } from "@lingui/core"
import type { CortexTask } from "@ericsanchezok/synergy-sdk/client"
import { useSDK } from "@/context/sdk"
import { useSessionDataView } from "@/context/session-data-view"
import { requestErrorMessage } from "@/utils/error"
import { translateDescriptor } from "@/locales/translate"
import type { ExecutionDetailState } from "@/components/session/execution-detail-model"
import type { WorkbenchPanelContentProps } from "@/plugin/registries/workbench-panel-registry"
import { useData } from "@ericsanchezok/synergy-ui/context/data"
import { Button } from "@ericsanchezok/synergy-ui/button"
import {
  compactionErrorText,
  resolveCompactionCardPresentation,
  type CompactionAttemptState,
} from "@ericsanchezok/synergy-ui/compaction-card"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { ExecutionCodeBlock } from "./execution-code-block"
import { ExecutionDetailLayout } from "./execution-detail-layout"
import { ExecutionReport, ExecutionTrajectory, ExecutionOriginal } from "./execution-report"
import { processTaskOutput, toolTaskOutput, type ProcessTaskOutput } from "./process-task-output"

export const taskStatuses: Record<string, MessageDescriptor> = {
  queued: { id: "session.execution.pending", message: "Pending" },
  running: { id: "session.execution.running", message: "Running" },
  completed: { id: "session.execution.completed", message: "Completed" },
  error: { id: "session.execution.failed", message: "Failed" },
  cancelled: { id: "session.process.cancelled", message: "Cancelled" },
  interrupted: { id: "session.process.interrupted", message: "Interrupted" },
}

export function ProcessEventDetailWorkbenchContent(
  props: WorkbenchPanelContentProps & { state: ExecutionDetailState },
) {
  const sdk = useSDK()
  const view = useSessionDataView()
  const data = useData()
  const { _, i18n } = useLingui()
  let controller: AbortController | undefined
  const identity = () =>
    `${props.state.server}:${props.state.scope}:${props.state.sessionID}:${props.state.messageID}:${props.state.kind}`
  const request = createMemo(() => {
    const state = props.state
    const live = view()
      .messagesFor(state.sessionID)
      .find((message) => message.id === state.messageID)
    return { ...state, identity: identity(), revision: JSON.stringify([live?.time, live?.metadata?.compactionAttempt]) }
  })
  const [snapshot, { refetch }] = createResource(
    request,
    async (target) => {
      controller?.abort()
      const current = new AbortController()
      controller = current
      const result = await sdk.client.session
        .message(
          { sessionID: target.sessionID, messageID: target.messageID },
          { signal: current.signal, throwOnError: true },
        )
        .catch((error: unknown) => {
          if (error instanceof Error) throw error
          throw new Error(
            requestErrorMessage(
              error,
              _({ id: "session.process.loadFailed", message: "Unable to load process details." }),
            ),
            { cause: error },
          )
        })
      if (!result.data || result.data.info.id !== target.messageID || result.data.info.sessionID !== target.sessionID)
        throw new Error(
          _({ id: "session.process.unavailable", message: "This process record is no longer available." }),
        )
      const message = result.data.info
      let output: ProcessTaskOutput | undefined
      let cortex: CortexTask | undefined
      if (
        target.kind === "agent-delivery" &&
        message.role === "user" &&
        message.origin?.type === "cortex" &&
        message.origin.taskID &&
        message.origin.sessionID
      ) {
        const child = await sdk.client.cortex
          .get(
            {
              taskID: message.origin.taskID,
              parentSessionID: target.sessionID,
              sessionID: message.origin.sessionID,
            },
            { signal: current.signal, throwOnError: true },
          )
          .catch(() => undefined)
        if (
          child?.data?.id === message.origin.taskID &&
          child.data.sessionID === message.origin.sessionID &&
          child.data.parentSessionID === target.sessionID
        ) {
          cortex = child.data
          output = processTaskOutput(cortex.output)
        }
      }
      if (
        current.signal.aborted ||
        identity() !== target.identity ||
        sdk.url !== target.server ||
        sdk.scopeKey !== target.scope
      )
        throw new DOMException("Aborted", "AbortError")
      return { ...result.data, output, cortex, identity: target.identity }
    },
    { initialValue: undefined },
  )
  onCleanup(() => controller?.abort())
  const saved = createMemo<(typeof snapshot)["latest"]>((previous) => {
    const owner = identity()
    if (snapshot.error) return previous?.identity === owner ? previous : undefined
    const next = snapshot.latest
    return next?.identity === owner ? next : undefined
  })
  const message = () => saved()?.info
  const taskID = () => {
    const current = message()
    return current?.role === "user" ? current.origin?.taskID : undefined
  }
  const captured = createMemo(() => {
    const task = taskID()
    if (!task) return
    for (const item of view().messagesFor(props.state.sessionID)) {
      for (const part of view().partsFor(item.id)) {
        if (
          part.type !== "tool" ||
          part.tool !== "task_output" ||
          part.state.status !== "completed" ||
          part.state.metadata.taskId !== task
        )
          continue
        const result = toolTaskOutput(part)
        if (result) return { output: result.report, status: result.status }
      }
    }
  })
  const raw = () =>
    saved()
      ?.parts.filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n\n") ?? ""
  const recovery = () => saved()?.parts.find((part) => part.type === "compaction_recovery")
  const error = () => {
    const current = message()
    return current?.role === "assistant" ? compactionErrorText(current.error) : undefined
  }
  const report = createMemo<ProcessTaskOutput>(() => {
    const summary = recovery()?.summary
    if (summary !== undefined) return { raw: summary, text: summary }
    return captured()?.output ?? saved()?.output ?? { raw: raw(), text: raw() }
  })
  const compaction = createMemo(() => {
    const current = message()
    if (props.state.kind !== "compaction" || current?.role !== "assistant") return
    return resolveCompactionCardPresentation({
      attemptState: (current.metadata?.compactionAttempt as { state?: CompactionAttemptState } | undefined)?.state,
      error: current.error,
      hasRecovery: !!recovery(),
      messageCompleted: current.time.completed != null,
      hasSummary: !!recovery()?.summary,
    })
  })
  const status = () => {
    const compact = compaction()?.status
    const value = compact
      ? compact === "complete"
        ? "completed"
        : compact === "failed"
          ? "error"
          : "running"
      : (captured()?.status ?? saved()?.cortex?.status)
    return typeof value === "string" && taskStatuses[value]
      ? translateDescriptor(taskStatuses[value], i18n())
      : undefined
  }
  const duration = () => {
    const task = saved()?.cortex
    const current = message()
    const time = props.state.kind === "compaction" && current?.role === "assistant" ? current.time : undefined
    const start = time?.created ?? task?.startedAt
    const end = time?.completed ?? task?.completedAt
    if (start === undefined || end === undefined) return
    return _({
      id: "session.execution.duration",
      message: "{seconds} s",
      values: {
        seconds: new Intl.NumberFormat(i18n().locale, { maximumFractionDigits: 1 }).format(
          Math.max(0, end - start) / 1000,
        ),
      },
    })
  }
  const title = () =>
    props.state.kind === "compaction"
      ? _({ id: "session.process.compactionDetail", message: "Context compaction" })
      : _({ id: "session.process.agentDetail", message: "Agent result" })
  const sourceID = () => {
    const current = message()
    return current?.role === "user" ? current.origin?.sessionID : undefined
  }
  const sourceLabel = () => {
    const current = message()
    return current?.role === "user" ? current.origin?.label : undefined
  }
  return (
    <ExecutionDetailLayout
      identity={identity()}
      id={props.tab.id}
      kind={props.state.kind}
      title={sourceLabel() || title()}
      icon={getSemanticIcon(props.state.kind === "compaction" ? "settings.compaction" : "agent.identity")}
      loading={snapshot.loading}
      error={snapshot.error}
      retry={refetch}
      views={
        props.state.kind === "compaction"
          ? ["result", "diagnostics"]
          : report().trajectory
            ? ["result", "process"]
            : ["result"]
      }
      meta={
        <>
          <Show when={sourceLabel()}>
            <span>{title()}</span>
          </Show>
          <Show when={status()}>{(label) => <span data-slot="execution-status">{label()}</span>}</Show>
          <Show when={duration()}>{(label) => <span>{label()}</span>}</Show>
        </>
      }
      actions={
        <Show when={sourceID()}>
          {(id) => (
            <Button variant="ghost" size="small" onClick={() => data.navigateToSession?.(id())}>
              {_({ id: "session.process.openSource", message: "Open source session" })}
            </Button>
          )}
        </Show>
      }
    >
      {(view) => (
        <Switch>
          <Match when={view() === "diagnostics"}>
            <Show
              when={error()}
              fallback={
                <Show when={!recovery()?.mechanical}>
                  <p data-slot="execution-evidence-gap">
                    {_({ id: "session.execution.noDiagnostics", message: "No additional diagnostics were recorded." })}
                  </p>
                </Show>
              }
            >
              {(text) => (
                <ExecutionCodeBlock
                  identity={identity()}
                  slot="execution-error"
                  label={_({ id: "session.execution.errorDetails", message: "Error details" })}
                  copyLabel={_({ id: "session.execution.copyError", message: "Copy error details" })}
                  text={text()}
                />
              )}
            </Show>
            <Show when={recovery()?.mechanical}>
              <p data-slot="execution-evidence-gap">
                {_({
                  id: "ui.compaction.mechanicalWarning",
                  message: "This summary was mechanically generated due to context limits. Some detail may be missing.",
                })}
              </p>
            </Show>
          </Match>
          <Match when={view() === "process"}>
            <ExecutionTrajectory identity={identity()} report={report()} />
            <ExecutionOriginal identity={identity()} text={report().raw} />
          </Match>
          <Match when={view() === "result"}>
            <Show
              when={saved()}
              fallback={
                <Show when={!snapshot.error}>
                  <p data-slot="execution-evidence-gap">
                    {_({ id: "session.execution.loading", message: "Loading tool result…" })}
                  </p>
                </Show>
              }
            >
              <Switch fallback={<ExecutionReport identity={identity()} report={report()} />}>
                <Match when={compaction()?.status === "running"}>
                  <p role="status" data-slot="execution-evidence-gap">
                    {_({ id: "ui.compaction.preparing", message: "Preparing a compact continuation summary" })}
                  </p>
                </Match>
                <Match when={compaction()?.status === "failed"}>
                  <p role="status" data-slot="execution-evidence-gap">
                    {_({
                      id: "session.process.compactionFailure",
                      message: "The summary could not be created. See Diagnostics for details.",
                    })}
                  </p>
                </Match>
              </Switch>
              <Show when={recovery()?.mechanical}>
                <p data-slot="execution-evidence-gap">
                  {_({
                    id: "session.process.mechanicalSummary",
                    message: "Mechanically generated summary. See Diagnostics for limitations.",
                  })}
                </p>
              </Show>
            </Show>
          </Match>
        </Switch>
      )}
    </ExecutionDetailLayout>
  )
}
