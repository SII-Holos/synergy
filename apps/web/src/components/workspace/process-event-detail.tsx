import { createEffect, createMemo, createResource, createSignal, onCleanup, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { useSDK } from "@/context/sdk"
import { useSessionDataView } from "@/context/session-data-view"
import { requestErrorMessage } from "@/utils/error"
import type { ExecutionDetailState } from "@/components/session/execution-detail-model"
import type { WorkbenchPanelContentProps } from "@/plugin/registries/workbench-panel-registry"
import { useData } from "@ericsanchezok/synergy-ui/context/data"
import { Markdown } from "@ericsanchezok/synergy-ui/markdown"
import { ErrorCard } from "@ericsanchezok/synergy-ui/error-card"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { createCopyController } from "@ericsanchezok/synergy-ui/clipboard"
import { compactionErrorText } from "@ericsanchezok/synergy-ui/compaction-card"

export function processTaskOutputText(output: unknown): string | undefined {
  if (!output || typeof output !== "object") return
  const saved = output as { mode?: unknown; value?: unknown }
  if ((saved.mode === "summary" || saved.mode === "final_response") && typeof saved.value === "string")
    return saved.value
  if (saved.mode === "structured" && "value" in saved) return JSON.stringify(saved.value, null, 2)
}

export function ProcessEventDetailWorkbenchContent(
  props: WorkbenchPanelContentProps & { state: ExecutionDetailState },
) {
  const sdk = useSDK()
  const view = useSessionDataView()
  const data = useData()
  const { _ } = useLingui()
  const [expanded, setExpanded] = createSignal(false)
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
  const [snapshot] = createResource(request, async (target) => {
    controller?.abort()
    const current = new AbortController()
    controller = current
    const result = await sdk.client.session.message(
      { sessionID: target.sessionID, messageID: target.messageID },
      { signal: current.signal, throwOnError: true },
    )
    if (!result.data || result.data.info.id !== target.messageID || result.data.info.sessionID !== target.sessionID)
      throw new Error(_({ id: "session.process.unavailable", message: "This process record is no longer available." }))
    const message = result.data.info
    let output: string | undefined
    if (
      target.kind === "agent-delivery" &&
      message.role === "user" &&
      message.origin?.type === "cortex" &&
      message.origin.taskID &&
      message.origin.sessionID
    ) {
      const child = await sdk.client.session
        .get({ sessionID: message.origin.sessionID }, { signal: current.signal, throwOnError: true })
        .catch(() => undefined)
      if (
        child?.data?.cortex?.taskID === message.origin.taskID &&
        child.data.cortex.parentSessionID === target.sessionID
      )
        output = processTaskOutputText(child.data.cortex.output)
    }
    if (
      current.signal.aborted ||
      identity() !== target.identity ||
      sdk.url !== target.server ||
      sdk.scopeKey !== target.scope
    )
      throw new DOMException("Aborted", "AbortError")
    return { ...result.data, output, identity: target.identity }
  })
  onCleanup(() => controller?.abort())
  createEffect(() => {
    identity()
    setExpanded(false)
  })
  const saved = () => (snapshot.latest?.identity === identity() ? snapshot.latest : undefined)
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
        const text = processTaskOutputText(part.state.metadata.output)
        if (text !== undefined) return text
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
  const result = () => recovery()?.summary ?? captured() ?? saved()?.output ?? raw()
  const title = () =>
    props.state.kind === "compaction"
      ? _({ id: "session.process.compactionDetail", message: "Context compaction" })
      : _({ id: "session.process.agentDetail", message: "Agent result" })
  const copy = createCopyController({
    text: result,
    get copyLabel() {
      return _({ id: "session.process.copyResult", message: "Copy result" })
    },
    get copiedLabel() {
      return _({ id: "session.execution.copied", message: "Copied" })
    },
    get failedLabel() {
      return _({ id: "session.execution.copyFailed", message: "Copy failed" })
    },
  })
  const sourceID = () => {
    const current = message()
    return current?.role === "user" ? current.origin?.sessionID : undefined
  }
  const sourceLabel = () => {
    const current = message()
    return current?.role === "user" ? current.origin?.label : undefined
  }
  return (
    <div data-component="execution-detail" data-kind={props.state.kind} aria-busy={snapshot.loading}>
      <header data-slot="execution-detail-heading">
        <h2>{title()}</h2>
        <Show when={sourceLabel()}>{(label) => <p>{label()}</p>}</Show>
        <Show when={sourceID()}>
          {(id) => (
            <Button variant="ghost" size="small" onClick={() => data.navigateToSession?.(id())}>
              {_({ id: "session.process.openSource", message: "Open source session" })}
            </Button>
          )}
        </Show>
      </header>
      <div data-slot="execution-detail-toolbar">
        <Button
          variant="ghost"
          size="small"
          icon={copy.icon()}
          aria-label={copy.tooltip()}
          disabled={!result() || copy.disabled()}
          onClick={() => void copy.copy()}
        />
        <span role="status">{copy.state() === "idle" ? "" : copy.tooltip()}</span>
      </div>
      <div data-slot="execution-detail-body">
        <Show when={snapshot.error && snapshot.error.name !== "AbortError"}>
          <ErrorCard
            error={requestErrorMessage(
              snapshot.error,
              _({ id: "session.process.loadFailed", message: "Unable to load process details." }),
            )}
          />
        </Show>
        <Show when={error()}>{(text) => <ErrorCard error={text()} />}</Show>
        <Show
          when={
            props.state.kind === "compaction" &&
            (message()?.metadata?.compactionAttempt as { state?: unknown } | undefined)?.state === "running"
          }
        >
          <p role="status">
            {_({ id: "ui.compaction.preparing", message: "Preparing a compact continuation summary" })}
          </p>
        </Show>
        <Show when={recovery()?.mechanical}>
          <p>
            {_({
              id: "ui.compaction.mechanicalWarning",
              message: "This summary was mechanically generated due to context limits. Some detail may be missing.",
            })}
          </p>
        </Show>
        <Show when={result()}>
          <Markdown text={expanded() ? result() : result().slice(0, 16000)} />
        </Show>
        <Show when={result().length > 16000 && !expanded()}>
          <Button variant="ghost" onClick={() => setExpanded(true)}>
            {_({ id: "session.execution.fullContent", message: "Show full content" })}
          </Button>
        </Show>
        <Show when={taskID() && captured() === undefined && saved()?.output === undefined}>
          <p>
            {_({
              id: "session.process.resultUnavailable",
              message: "The full task result is not available. The original notification is shown.",
            })}
          </p>
        </Show>
      </div>
    </div>
  )
}
