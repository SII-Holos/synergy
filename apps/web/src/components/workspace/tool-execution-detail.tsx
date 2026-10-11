import { createEffect, createMemo, createResource, createSignal, on, onCleanup, Show, Match, Switch } from "solid-js"
import { useParams } from "@solidjs/router"
import { useLingui } from "@lingui/solid"
import type { MessageDescriptor } from "@lingui/core"
import type { ToolPart } from "@ericsanchezok/synergy-sdk/client"
import { useSDK } from "@/context/sdk"
import { useSessionDataView } from "@/context/session-data-view"
import { executionDetailSelection, executionDetailState } from "@/components/session/execution-detail-model"
import type { WorkbenchPanelContentProps } from "@/plugin/registries/workbench-panel-registry"
import { ToolResultBody } from "@ericsanchezok/synergy-ui/tool-result-body"
import { AttachmentGallery } from "@ericsanchezok/synergy-ui/attachment-card"
import {
  externalLookup,
  externalLoadNotify,
  resolveExternalToolRenderer,
} from "@ericsanchezok/synergy-ui/tool-registry-lazy"
import { getToolInfo } from "@ericsanchezok/synergy-ui/message-part"
import { translateDescriptor } from "@/locales/translate"
import "./tool-execution-detail.css"
import { ProcessEventDetailWorkbenchContent, taskStatuses } from "./process-event-detail"
import { ExecutionCodeBlock } from "./execution-code-block"
import { ExecutionDetailLayout } from "./execution-detail-layout"
import { ExecutionReport, ExecutionTrajectory, ExecutionOriginal } from "./execution-report"
import { toolTaskOutput } from "./process-task-output"
import { requestErrorMessage } from "@/utils/error"

const statuses: Record<ToolPart["state"]["status"], MessageDescriptor> = {
  pending: { id: "session.execution.pending", message: "Pending" },
  generating: { id: "session.execution.generating", message: "Preparing tool input" },
  running: { id: "session.execution.running", message: "Running" },
  completed: { id: "session.execution.completed", message: "Completed" },
  error: { id: "session.execution.failed", message: "Failed" },
}

export function ExecutionDetailWorkbenchContent(props: WorkbenchPanelContentProps) {
  const sdk = useSDK()
  const params = useParams()
  const state = () =>
    executionDetailState(props.tab.state, { server: sdk.url, scope: sdk.scopeKey, sessionID: params.id ?? "" })
  return (
    <Show when={state()}>
      {(selection) => (
        <Show
          when={selection().kind === "tool"}
          fallback={<ProcessEventDetailWorkbenchContent {...props} state={selection()} />}
        >
          <ToolExecutionDetailWorkbenchContent {...props} />
        </Show>
      )}
    </Show>
  )
}

function ToolExecutionDetailWorkbenchContent(props: WorkbenchPanelContentProps) {
  const sdk = useSDK()
  const params = useParams()
  const data = useSessionDataView()
  const { _, i18n } = useLingui()
  const owner = () => ({ server: sdk.url, scope: sdk.scopeKey, sessionID: params.id ?? "" })
  const state = createMemo(() => {
    const value = executionDetailState(props.tab.state, owner())
    return value?.kind === "tool" ? value : undefined
  })
  const selectionIdentity = createMemo(() => JSON.stringify(state()))
  const selected = createMemo(() => (state() ? executionDetailSelection(state()!) : undefined))
  const live = createMemo(() => {
    const target = selected()
    if (!target) return
    const part = data()
      .partsFor(target.messageID)
      .find((part) => part.id === target.partID)
    return part?.type === "tool" &&
      part.sessionID === target.sessionID &&
      (!target.callID || part.callID === target.callID)
      ? part
      : undefined
  })
  const [processRevision, setProcessRevision] = createSignal(0)
  onCleanup(
    sdk.event.on("session.tool.activity", (event) => {
      const target = selected()
      if (
        target?.sessionID === event.properties.sessionID &&
        target.messageID === event.properties.messageID &&
        (target.callID ?? live()?.callID) === event.properties.callID
      )
        setProcessRevision(event.properties.revision)
    }),
  )
  let output: HTMLElement | undefined
  let following = true
  let frame: number | undefined
  let controller: AbortController | undefined
  const request = createMemo(
    () => {
      const target = selected()
      const current = state()
      return target && current
        ? {
            ...current,
            ...target,
            revision: `${live()?.state.status}:${live()?.activityEvidence?.content?.id ?? ""}:${processRevision()}`,
          }
        : undefined
    },
    undefined,
    {
      equals: (a, b) =>
        a?.server === b?.server &&
        a?.scope === b?.scope &&
        a?.sessionID === b?.sessionID &&
        a?.messageID === b?.messageID &&
        a?.partID === b?.partID &&
        a?.callID === b?.callID &&
        a?.revision === b?.revision,
    },
  )
  const [snapshot, { refetch }] = createResource(request, async (target) => {
    controller?.abort()
    const current = new AbortController()
    controller = current
    const result = await sdk.client.session
      .toolActivity(
        { sessionID: target.sessionID, messageID: target.messageID, partID: target.partID, callID: target.callID },
        { signal: current.signal, throwOnError: true },
      )
      .catch((error: unknown) => {
        if (error instanceof Error) throw error
        throw new Error(
          requestErrorMessage(
            error,
            _({ id: "session.execution.loadFailed", message: "Unable to load execution details." }),
          ),
          { cause: error },
        )
      })
    if (
      current.signal.aborted ||
      !executionDetailState(target, owner()) ||
      selected()?.partID !== target.partID ||
      selected()?.messageID !== target.messageID ||
      selected()?.callID !== target.callID
    )
      throw new DOMException("Aborted", "AbortError")
    if (
      !result.data ||
      result.data.part.sessionID !== target.sessionID ||
      result.data.part.messageID !== target.messageID ||
      result.data.part.id !== target.partID ||
      (target.callID && result.data.part.callID !== target.callID)
    )
      throw new Error(_({ id: "session.execution.unavailable", message: "This tool result is no longer available." }))
    return { target, result: result.data }
  })
  createEffect(() => {
    if (!request()) controller?.abort()
  })
  onCleanup(() => {
    controller?.abort()
    if (frame !== undefined) cancelAnimationFrame(frame)
  })
  const saved = createMemo<(typeof snapshot)["latest"]>((previous) => {
    const target = selected()
    const next = snapshot.error ? previous : snapshot.latest
    return next &&
      target &&
      executionDetailState(next.target, owner()) &&
      next.target.messageID === target.messageID &&
      next.target.partID === target.partID &&
      next.target.callID === target.callID
      ? next
      : undefined
  })
  const captured = () => saved()?.result
  const part = () => captured()?.part ?? live()
  const info = () => (part() ? getToolInfo(part()!.tool, part()!.state.input, part()!.state.metadata ?? {}) : undefined)
  const input = () => (part() ? JSON.stringify(part()!.state.input, null, 2) : "")
  const failure = () => {
    const state = part()?.state
    return state?.status === "error" ? state.error : undefined
  }
  const status = createMemo(() => {
    const process = captured()?.process
    if (process?.status === "running")
      return { state: "running", label: _({ id: "session.execution.background", message: "Process is still running" }) }
    if (process?.status === "interrupted")
      return { state: "interrupted", label: _({ id: "session.execution.interrupted", message: "Interrupted" }) }
    if (process?.status === "failed") return { state: "error", label: translateDescriptor(statuses.error, i18n()) }
    const current = part()
    return {
      state: current?.state.status,
      label: current ? translateDescriptor(statuses[current.state.status], i18n()) : "",
    }
  })
  const file = () => part()?.activityEvidence?.kind === "file-read"
  const rawOutput = () => {
    const current = part()?.state
    if (current?.status === "running" && typeof current.metadata?.output === "string") return current.metadata.output
    if (captured()?.text !== undefined) return captured()!.text!
    return current?.status === "completed" ? current.output : current?.status === "error" ? current.error : ""
  }
  const result = createMemo(() => {
    const text = rawOutput()
    if (file() || part()?.activityEvidence?.kind === "command" || captured()?.process) return { text }
    try {
      const value: unknown = JSON.parse(text)
      return { text: JSON.stringify(value, null, 2), language: "json" as const }
    } catch {
      return { text }
    }
  })
  const taskOutput = createMemo(() => (part() ? toolTaskOutput(part()!) : undefined))
  const taskStatus = () => {
    const value = taskOutput()?.status
    return typeof value === "string" && taskStatuses[value]
      ? translateDescriptor(taskStatuses[value], i18n())
      : undefined
  }
  const incomplete = () => {
    const current = part()
    return !!(
      captured()?.truncated ||
      current?.activityEvidence?.truncated ||
      (captured()?.text === undefined && current?.state.status === "completed" && current.state.outputTruncated)
    )
  }
  const customResult = createMemo(() =>
    part() ? resolveExternalToolRenderer(part()!.tool, { externalLookup, externalLoadNotify }) : undefined,
  )
  const richResult = () =>
    part()?.activityEvidence?.kind === "file-change" || part()?.activityEvidence?.kind === "media" || !!customResult()
  const attachments = () => {
    const current = part()?.state
    return current?.status === "completed" ? (current.attachments ?? []) : []
  }
  const duration = () => {
    const current = part()
    if (!current || !("time" in current.state) || !("end" in current.state.time) || current.state.time.end == null)
      return
    return _({
      id: "session.execution.duration",
      message: "{seconds} s",
      values: {
        seconds: new Intl.NumberFormat(i18n().locale, { maximumFractionDigits: 1 }).format(
          Math.max(0, current.state.time.end - current.state.time.start) / 1000,
        ),
      },
    })
  }
  createEffect(
    on(selectionIdentity, () => {
      following = true
      if (output) output.scrollTop = 0
    }),
  )
  createEffect(() => {
    const current = part()
    const content = current?.state.status === "running" ? current.state.metadata?.output : captured()?.text
    void content
    if (!output || !following || (current?.state.status !== "running" && captured()?.process?.status !== "running"))
      return
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      if (output && following) output.scrollTop = output.scrollHeight
    })
  })
  const blockIdentity = () =>
    `${sdk.url}:${sdk.scopeKey}:${part()?.sessionID}:${part()?.messageID}:${part()?.id}:${part()?.callID}`
  return (
    <ExecutionDetailLayout
      identity={selectionIdentity()}
      id={props.tab.id}
      kind="tool"
      title={part()?.tool ?? _({ id: "session.execution.result", message: "Result" })}
      icon={info()?.icon ?? "activity"}
      brief={part()?.workBrief}
      loading={snapshot.loading}
      error={snapshot.error}
      retry={refetch}
      views={taskOutput()?.report.trajectory ? ["result", "process", "diagnostics"] : ["result", "diagnostics"]}
      diagnosticsLabel={_({ id: "session.execution.diagnostics", message: "Parameters and diagnostics" })}
      meta={
        <>
          <span data-slot="execution-status" data-state={status().state}>
            {status().label}
          </span>
          <Show when={duration()}>{(label) => <span>{label()}</span>}</Show>
          <Show when={taskStatus()}>
            {(label) => (
              <span>
                {_({
                  id: "session.execution.taskStatus",
                  message: "Task status: {status}",
                  values: { status: label() },
                })}
              </span>
            )}
          </Show>
        </>
      }
      details={
        <>
          <Show when={part()?.activityEvidence?.directory}>
            <p data-slot="execution-directory">{part()?.activityEvidence?.directory}</p>
          </Show>
          <Show when={typeof captured()?.process?.exitCode === "number"}>
            <p>
              {_({
                id: "session.execution.exit",
                message: "Exit code: {code}",
                values: { code: captured()?.process?.exitCode },
              })}
            </p>
          </Show>
          <Show when={captured()?.process?.signal}>
            {(signal) => (
              <p>
                {_({
                  id: "session.execution.signal",
                  message: "Termination signal: {signal}",
                  values: { signal: signal() },
                })}
              </p>
            )}
          </Show>
        </>
      }
      bodyRef={(element) => {
        output = element
      }}
      onScroll={() => {
        if (output) following = output.scrollHeight - output.scrollTop - output.clientHeight < 32
      }}
    >
      {(view) => (
        <Show
          when={part()}
          fallback={
            <Show when={!snapshot.error}>
              <p data-slot="execution-evidence-gap">
                {state()
                  ? _({ id: "session.execution.loading", message: "Loading tool result…" })
                  : _({ id: "session.execution.unavailable", message: "This tool result is no longer available." })}
              </p>
            </Show>
          }
        >
          {(current) => (
            <Switch>
              <Match when={view() === "diagnostics"}>
                <ExecutionCodeBlock
                  identity={blockIdentity()}
                  slot="execution-input"
                  language="json"
                  label={_({ id: "session.execution.input", message: "Tool input" })}
                  copyLabel={_({ id: "session.execution.copyInput", message: "Copy tool input" })}
                  text={input()}
                />
                <Show when={failure()}>
                  {(error) => (
                    <ExecutionCodeBlock
                      identity={blockIdentity()}
                      slot="execution-error"
                      label={_({ id: "session.execution.errorDetails", message: "Error details" })}
                      copyLabel={_({ id: "session.execution.copyError", message: "Copy error details" })}
                      text={error()}
                    />
                  )}
                </Show>
                <Show when={taskOutput()}>
                  <ExecutionOriginal identity={blockIdentity()} text={rawOutput()} incomplete={incomplete()} />
                </Show>
              </Match>
              <Match when={view() === "process"}>
                <Show when={taskOutput()}>
                  {(task) => (
                    <>
                      <ExecutionTrajectory identity={blockIdentity()} report={task().report} />
                      <ExecutionOriginal identity={blockIdentity()} text={task().report.raw} />
                    </>
                  )}
                </Show>
              </Match>
              <Match when={view() === "result"}>
                <Show when={file()}>
                  <div data-slot="execution-file-context">
                    <span>{_({ id: "session.execution.captured", message: "Captured during this invocation" })}</span>
                    <Show when={part()!.activityEvidence?.range}>
                      {(range) => (
                        <span>
                          {_({
                            id: "session.execution.lineRange",
                            message: "Lines {start}–{end}",
                            values: { start: range().startLine + 1, end: range().startLine + range().lineCount },
                          })}
                        </span>
                      )}
                    </Show>
                    <Show when={part()!.activityEvidence?.ranges && !part()!.activityEvidence?.range}>
                      <span>
                        {current()
                          .activityEvidence?.ranges?.map(
                            (range) => `${range.startLine + 1}–${range.startLine + range.lineCount}`,
                          )
                          .join(" · ")}
                      </span>
                    </Show>
                  </div>
                </Show>
                <Show
                  when={
                    captured()?.evidenceMissing &&
                    (part()!.tool === "read" || part()!.tool === "view_file") &&
                    part()!.state.status === "completed"
                  }
                >
                  <p data-slot="execution-evidence-gap">
                    {_({
                      id: "session.execution.evidenceMissing",
                      message:
                        "Captured file content is unavailable for this invocation. The recorded tool output is shown below.",
                    })}
                  </p>
                </Show>
                <Show when={captured()?.process?.status === "interrupted"}>
                  <p data-slot="execution-command-context">
                    {_({ id: "session.execution.interruptedOutput", message: "Output captured before interruption" })}
                  </p>
                </Show>

                <Show
                  when={taskOutput()}
                  fallback={
                    <Show
                      when={richResult()}
                      fallback={
                        <>
                          <ExecutionCodeBlock
                            identity={blockIdentity()}
                            slot="execution-output"
                            label={
                              current().activityEvidence?.kind === "command" || captured()?.process
                                ? _({ id: "session.execution.commandOutput", message: "Command output" })
                                : _({ id: "session.execution.toolOutput", message: "Tool output" })
                            }
                            copyLabel={_({ id: "session.execution.copyOutput", message: "Copy tool output" })}
                            text={result().text}
                            language={result().language}
                            incomplete={incomplete()}
                          />
                          <AttachmentGallery files={attachments()} serverUrl={sdk.url} />
                        </>
                      }
                    >
                      <section data-slot="execution-rich-result">
                        <ToolResultBody
                          part={current()}
                          serverUrl={sdk.url}
                          sessionId={current().sessionID}
                          messageId={current().messageID}
                          resultOnly
                          defaultOpen
                        />
                      </section>
                      <ExecutionOriginal
                        identity={blockIdentity()}
                        text={rawOutput()}
                        incomplete={incomplete()}
                        copyLabel={_({ id: "session.execution.copyOutput", message: "Copy tool output" })}
                      />
                    </Show>
                  }
                >
                  {(task) => (
                    <>
                      <ExecutionReport identity={blockIdentity()} report={task().report} />
                      <AttachmentGallery files={attachments()} serverUrl={sdk.url} />
                    </>
                  )}
                </Show>
              </Match>
            </Switch>
          )}
        </Show>
      )}
    </ExecutionDetailLayout>
  )
}
