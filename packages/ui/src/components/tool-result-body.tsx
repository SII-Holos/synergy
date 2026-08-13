import type {
  AttachmentPart,
  ToolPart,
  ToolStateCompleted,
  ToolStateError,
  ToolStateGenerating,
} from "@ericsanchezok/synergy-sdk/client"
import { parsePartialJson } from "@ericsanchezok/synergy-util/json"
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { createAnimatedNumber } from "../hooks"
import { AttachmentGallery } from "./attachment-card"
import { SmartTool, ToolResultPresentationProvider } from "./basic-tool"
import { ErrorCard } from "./error-card"
import {
  externalFallbackLookup,
  externalLoadNotify,
  externalLookup,
  resolveToolRenderer,
  ToolRegistry,
  type ToolProps,
} from "./tool-registry-lazy"

const TEXT_RENDER_THROTTLE_MS = 100

function createThrottledValue(getValue: () => string) {
  const [value, setValue] = createSignal(getValue())
  let timeout: ReturnType<typeof setTimeout> | undefined
  let last = 0

  createEffect(() => {
    const next = getValue()
    const now = Date.now()
    const remaining = TEXT_RENDER_THROTTLE_MS - (now - last)
    if (remaining <= 0) {
      if (timeout) {
        clearTimeout(timeout)
        timeout = undefined
      }
      last = now
      setValue(next)
      return
    }
    if (timeout) clearTimeout(timeout)
    timeout = setTimeout(() => {
      last = Date.now()
      setValue(next)
      timeout = undefined
    }, remaining)
  })

  onCleanup(() => {
    if (timeout) clearTimeout(timeout)
  })

  return value
}

function fallbackRender(props: ToolProps) {
  return (
    <SmartTool
      tool={props.tool}
      input={props.input}
      title={props.title}
      output={props.output}
      status={props.status}
      charsReceived={props.charsReceived}
      metadata={props.metadata}
      time={props.time}
      hideDetails={props.hideDetails}
      fallbackMeta={externalFallbackLookup?.(props.tool)}
    />
  )
}

export function ToolResultBody(props: {
  part: ToolPart
  serverUrl: string
  sessionId?: string
  messageId?: string
  hideDetails?: boolean
  defaultOpen?: boolean
  resultOnly?: boolean
}) {
  const state = () => props.part.state
  const throttledRaw = createThrottledValue(() => {
    const current = state()
    return current.status === "pending" || current.status === "generating" ? current.raw : ""
  })
  const [streamInput, setStreamInput] = createStore<Record<string, any>>({})
  createEffect(() => {
    const raw = throttledRaw()
    if (raw) setStreamInput(reconcile(parsePartialJson(raw)))
  })
  const input = () => (throttledRaw() ? streamInput : (state().input ?? {}))
  const metadata = () => state().metadata ?? {}
  const render = createMemo(() =>
    resolveToolRenderer(props.part.tool, ToolRegistry, { externalLookup, externalLoadNotify }),
  )
  const component = createMemo(() => render() ?? fallbackRender)
  const completed = () => (state().status === "completed" ? (state() as ToolStateCompleted) : undefined)
  const error = () => (state().status === "error" ? (state() as ToolStateError) : undefined)
  const generating = () => (state().status === "generating" ? (state() as ToolStateGenerating) : undefined)
  const output = () => completed()?.output
  const time = () => {
    const current = state()
    if (current.status === "running" || current.status === "completed" || current.status === "error") {
      return current.time
    }
    return undefined
  }
  const charsAnimated = createAnimatedNumber(() => generating()?.charsReceived ?? 0)
  const attachments = createMemo<AttachmentPart[]>(() => completed()?.attachments ?? [])
  const result = () => (
    <Show
      when={error()?.error}
      fallback={
        <Dynamic
          component={component()}
          input={input()}
          tool={props.part.tool}
          metadata={metadata()}
          title={completed()?.title}
          output={output()}
          status={state().status}
          time={time()}
          raw={generating()?.raw}
          charsReceived={charsAnimated()}
          hideDetails={props.hideDetails}
          defaultOpen={props.defaultOpen}
          sessionId={props.sessionId}
          messageId={props.messageId}
          attachments={completed()?.attachments}
        />
      }
    >
      {(message) => (
        <ErrorCard
          error={message()}
          input={error()?.input as Record<string, unknown> | undefined}
          defaultOpen={props.defaultOpen}
        />
      )}
    </Show>
  )

  const attachmentsDisplay = () => (
    <Show when={props.part.tool !== "attach" && attachments().length > 0}>
      <AttachmentGallery files={attachments()} serverUrl={props.serverUrl} />
    </Show>
  )

  return (
    <Show
      when={props.resultOnly}
      fallback={
        <>
          {result()}
          {attachmentsDisplay()}
        </>
      }
    >
      <div data-component="tool-result-body" data-presentation="result">
        <ToolResultPresentationProvider>{result()}</ToolResultPresentationProvider>
        {attachmentsDisplay()}
      </div>
    </Show>
  )
}
