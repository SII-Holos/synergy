import { createEffect, createMemo, createResource, createSignal, on, onCleanup, Show } from "solid-js"
import { useParams } from "@solidjs/router"
import { useLingui } from "@lingui/solid"
import type { MessageDescriptor } from "@lingui/core"
import type { ToolPart } from "@ericsanchezok/synergy-sdk/client"
import { useSDK } from "@/context/sdk"
import { useSessionDataView } from "@/context/session-data-view"
import { executionDetailSelection, executionDetailState } from "@/components/session/execution-detail-model"
import type { WorkbenchPanelContentProps } from "@/plugin/registries/workbench-panel-registry"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { ToolResultBody } from "@ericsanchezok/synergy-ui/tool-result-body"
import { AttachmentGallery } from "@ericsanchezok/synergy-ui/attachment-card"
import {
  externalLookup,
  externalLoadNotify,
  resolveExternalToolRenderer,
} from "@ericsanchezok/synergy-ui/tool-registry-lazy"
import { ErrorCard } from "@ericsanchezok/synergy-ui/error-card"
import { getToolInfo } from "@ericsanchezok/synergy-ui/message-part"
import { createCopyController } from "@ericsanchezok/synergy-ui/clipboard"
import { translateDescriptor } from "@/locales/translate"
import "./tool-execution-detail.css"
import { ProcessEventDetailWorkbenchContent } from "./process-event-detail"

const statuses: Record<ToolPart["state"]["status"], MessageDescriptor> = {
  pending: { id: "session.execution.pending", message: "Pending" },
  generating: { id: "session.execution.generating", message: "Preparing tool input" },
  running: { id: "session.execution.running", message: "Running" },
  completed: { id: "session.execution.completed", message: "Completed" },
  error: { id: "session.execution.failed", message: "Failed" },
}

function ExecutionCodeBlock(props: {
  identity: string
  slot: string
  label: string
  copyLabel: string
  text: string
  language?: "json"
}) {
  const { _ } = useLingui()
  const [expanded, setExpanded] = createSignal(false)
  const identity = createMemo(() => props.identity)
  const copy = createCopyController({
    text: () => props.text,
    get copyLabel() {
      return props.copyLabel
    },
    get copiedLabel() {
      return _({ id: "session.execution.copied", message: "Copied" })
    },
    get failedLabel() {
      return _({ id: "session.execution.copyFailed", message: "Copy failed" })
    },
  })
  createEffect(
    on(identity, () => {
      setExpanded(false)
      copy.reset()
    }),
  )
  return (
    <section data-component="execution-code-block" data-slot={props.slot} aria-label={props.label}>
      <header>
        <h3>{props.label}</h3>
        <span data-slot="execution-code-language">{props.language === "json" ? "JSON" : "text"}</span>
        <Button
          variant="ghost"
          size="small"
          icon={copy.icon()}
          aria-label={props.copyLabel}
          title={copy.tooltip()}
          disabled={copy.disabled()}
          onClick={() => void copy.copy()}
        />
        <span data-slot="execution-copy-feedback" role="status">
          {copy.state() === "idle" ? "" : copy.tooltip()}
        </span>
      </header>
      <div data-slot="execution-code-content">
        <Show
          when={props.text.length > 0}
          fallback={<p>{_({ id: "session.execution.noOutput", message: "No output captured." })}</p>}
        >
          <pre>
            <code>{expanded() ? props.text : props.text.slice(0, 16000)}</code>
          </pre>
        </Show>
      </div>
      <Show when={props.text.length > 16000 && !expanded()}>
        <button type="button" data-slot="execution-code-expand" onClick={() => setExpanded(true)}>
          {_({ id: "session.execution.fullContent", message: "Show full content" })}
        </button>
      </Show>
    </section>
  )
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
  const [tab, setTab] = createSignal<"result" | "diagnostics">("result")
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
  const [snapshot] = createResource(request, async (target) => {
    controller?.abort()
    const current = new AbortController()
    controller = current
    const result = await sdk.client.session.toolActivity(
      { sessionID: target.sessionID, messageID: target.messageID, partID: target.partID, callID: target.callID },
      { signal: current.signal, throwOnError: true },
    )
    if (current.signal.aborted || !executionDetailState(target, owner()) || selected()?.partID !== target.partID)
      throw new DOMException("Aborted", "AbortError")
    if (
      !result.data ||
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
  const captured = () => {
    const target = selected()
    const saved = snapshot.error ? undefined : snapshot.latest
    return saved &&
      target &&
      executionDetailState(saved.target, owner()) &&
      saved.target.messageID === target.messageID &&
      saved.target.partID === target.partID
      ? saved.result
      : undefined
  }
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
      setTab("result")
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
  const tabKey = (event: KeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
    event.preventDefault()
    setTab(tab() === "result" ? "diagnostics" : "result")
    const root = (event.currentTarget as HTMLElement).parentElement
    queueMicrotask(() => root?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus())
  }
  const panelID = (name: string) => `activity-${props.tab.id}-${name}`
  const blockIdentity = () =>
    `${sdk.url}:${sdk.scopeKey}:${part()?.sessionID}:${part()?.messageID}:${part()?.id}:${part()?.callID}`
  return (
    <div data-component="execution-detail">
      <Show
        when={part()}
        fallback={
          <div data-slot="execution-detail-empty">
            <Show
              when={snapshot.error}
              fallback={
                state()
                  ? _({ id: "session.execution.loading", message: "Loading tool result…" })
                  : _({ id: "session.execution.unavailable", message: "This tool result is no longer available." })
              }
            >
              <ErrorCard error={String(snapshot.error?.message ?? snapshot.error)} />
            </Show>
          </div>
        }
      >
        {(current) => (
          <>
            <header data-slot="execution-detail-heading">
              <div data-slot="execution-detail-resource">
                <Icon name={info()?.icon ?? "activity"} size="normal" />
                <h2>{current().tool}</h2>
              </div>
              <Show when={current().workBrief}>
                <p data-slot="execution-brief">{current().workBrief}</p>
              </Show>
              <p data-state={status().state}>
                <span data-slot="execution-status">{status().label}</span>
                <Show when={duration()}> · {duration()}</Show>
              </p>
              <Show when={current().activityEvidence?.directory}>
                <p data-slot="execution-directory">{current().activityEvidence?.directory}</p>
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
            </header>
            <div data-slot="execution-detail-toolbar">
              <div role="tablist" aria-label={_({ id: "session.execution.views", message: "Tool activity views" })}>
                <button
                  type="button"
                  role="tab"
                  id={panelID("result-tab")}
                  aria-controls={panelID("result")}
                  aria-selected={tab() === "result"}
                  tabindex={tab() === "result" ? 0 : -1}
                  onClick={() => setTab("result")}
                  onKeyDown={tabKey}
                >
                  {_({ id: "session.execution.result", message: "Result" })}
                </button>
                <button
                  type="button"
                  role="tab"
                  id={panelID("diagnostics-tab")}
                  aria-controls={panelID("diagnostics")}
                  aria-selected={tab() === "diagnostics"}
                  tabindex={tab() === "diagnostics" ? 0 : -1}
                  onClick={() => setTab("diagnostics")}
                  onKeyDown={tabKey}
                >
                  {_({ id: "session.execution.diagnostics", message: "Parameters and diagnostics" })}
                </button>
              </div>
            </div>
            <section
              ref={output}
              data-slot="execution-detail-body"
              onScroll={() => {
                if (output) following = output.scrollHeight - output.scrollTop - output.clientHeight < 32
              }}
            >
              <Show when={snapshot.error && snapshot.error.name !== "AbortError"}>
                <ErrorCard error={String(snapshot.error?.message ?? snapshot.error)} />
              </Show>
              <Show
                when={tab() === "result"}
                fallback={
                  <div
                    role="tabpanel"
                    id={panelID("diagnostics")}
                    aria-labelledby={panelID("diagnostics-tab")}
                    tabindex="0"
                  >
                    <ExecutionCodeBlock
                      identity={blockIdentity()}
                      slot="execution-input"
                      label={_({ id: "session.execution.input", message: "Tool input" })}
                      copyLabel={_({ id: "session.execution.copyInput", message: "Copy tool input" })}
                      text={input()}
                      language="json"
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
                  </div>
                }
              >
                <div role="tabpanel" id={panelID("result")} aria-labelledby={panelID("result-tab")} tabindex="0">
                  <Show when={file()}>
                    <div data-slot="execution-file-context">
                      <span>{_({ id: "session.execution.captured", message: "Captured during this invocation" })}</span>
                      <Show when={current().activityEvidence?.range}>
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
                      <Show when={current().activityEvidence?.ranges && !current().activityEvidence?.range}>
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
                      (current().tool === "read" || current().tool === "view_file") &&
                      current().state.status === "completed"
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
                  />
                  <Show when={richResult()} fallback={<AttachmentGallery files={attachments()} serverUrl={sdk.url} />}>
                    <ToolResultBody
                      part={current()}
                      serverUrl={sdk.url}
                      sessionId={current().sessionID}
                      messageId={current().messageID}
                      resultOnly
                      defaultOpen
                    />
                  </Show>
                  <Show when={captured()?.truncated}>
                    <p data-slot="execution-evidence-gap">
                      {_({ id: "session.execution.truncated", message: "Only part of this result is shown." })}
                    </p>
                  </Show>
                </div>
              </Show>
            </section>
          </>
        )}
      </Show>
    </div>
  )
}
