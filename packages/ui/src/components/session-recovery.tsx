import type { AssistantMessage, Part, SessionStatus } from "@ericsanchezok/synergy-sdk/client"
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { useViewActivity } from "../context/view-activity"
import { ErrorCard } from "./error-card"
import { errorPreview } from "./error-card-content"

export type SessionRecoveryAction = { sessionID: string } & (
  { kind: "retry"; messageID: string } | { kind: "authenticate"; providerID: string } | { kind: "select_model" }
)

export function sessionRecoveryMessage(
  messages: readonly AssistantMessage[],
  partsFor: (id: string) => readonly Part[],
) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.error) return message
    if (
      message.finish ||
      partsFor(message.id).some(
        (part) => part.type === "tool" || ((part.type === "text" || part.type === "reasoning") && part.text.length > 0),
      )
    )
      return
  }
}

export function SessionRecovery(props: {
  sessionID: string
  rootID: string
  messageID?: string
  providerID?: string
  current: boolean
  status?: SessionStatus
  error?: AssistantMessage["error"]
  summary?: string
  onAction?: (action: SessionRecoveryAction) => Promise<void>
}) {
  const { _ } = useLingui()
  const active = useViewActivity()
  const [now, setNow] = createSignal(Date.now())
  const [pending, setPending] = createSignal(false)
  const [actionError, setActionError] = createSignal<string>()
  const retry = createMemo(() =>
    props.status?.type === "retry" && props.status.rootID === props.rootID ? props.status : undefined,
  )
  const visible = () => !!retry() || !!props.error
  const connecting = () =>
    retry()?.phase === "connecting" || (props.current && !!props.error && props.status?.type === "busy")
  createEffect(() => {
    setNow(Date.now())
    if (!active() || retry()?.next === undefined) return
    const timer = setInterval(() => setNow(Date.now()), 250)
    onCleanup(() => clearInterval(timer))
  })
  const seconds = () => Math.max(0, Math.ceil(((retry()?.next ?? now()) - now()) / 1000))
  const summary = () => {
    const state = retry()
    if (connecting()) return _({ id: "ui.recovery.connecting", message: "Reconnecting" })
    if (state?.phase === "waiting_provider")
      return _({ id: "ui.recovery.provider", message: "Waiting for the model connection to recover" })
    if (state) return errorPreview(state.message)
    return (
      props.summary ??
      (props.error && "message" in props.error.data
        ? errorPreview(String(props.error.data.message))
        : _({ id: "ui.recovery.failed", message: "Request failed" }))
    )
  }
  const description = () => {
    const state = retry()
    if (connecting()) return _({ id: "ui.recovery.waitingResponse", message: "Waiting for a model response" })
    if (!state) return undefined
    if (state.next === undefined) return undefined
    if (seconds() === 0) return _({ id: "ui.recovery.starting", message: "Preparing to retry" })
    return state.attempt > 0
      ? _({
          id: "ui.recovery.countdownAttempt",
          message: "Retry {attempt} · Automatically retrying in {seconds}s",
          values: { attempt: state.attempt, seconds: seconds() },
        })
      : _({
          id: "ui.recovery.countdown",
          message: "Automatically retrying in {seconds}s",
          values: { seconds: seconds() },
        })
  }
  const action = createMemo<SessionRecoveryAction | undefined>(() => {
    if (!props.onAction || !props.current || props.status?.type === "busy") return
    const state = retry()
    if (state)
      return state.canRetry ? { kind: "retry", sessionID: props.sessionID, messageID: state.messageID } : undefined
    const error = props.error
    if (error?.name === "ProviderAuthError")
      return { kind: "authenticate", sessionID: props.sessionID, providerID: error.data.providerID }
    if (error?.name === "ProviderModelUnavailableError" || error?.name === "ProviderModelVariantUnavailableError")
      return { kind: "select_model", sessionID: props.sessionID }
    if (error?.name !== "APIError") return
    if (error.data.statusCode === 401 && props.providerID)
      return { kind: "authenticate", sessionID: props.sessionID, providerID: props.providerID }
    if (error.data.isRetryable && props.messageID)
      return { kind: "retry", sessionID: props.sessionID, messageID: props.messageID }
  })
  const actionLabel = () => {
    switch (action()?.kind) {
      case "retry":
        return retry()
          ? _({ id: "ui.recovery.retryNow", message: "Retry now" })
          : _({ id: "ui.recovery.retry", message: "Retry" })
      case "authenticate":
        return _({ id: "ui.recovery.reconnect", message: "Reconnect" })
      case "select_model":
        return _({ id: "ui.recovery.selectModel", message: "Choose model" })
      default:
        return _({ id: "ui.recovery.retry", message: "Retry" })
    }
  }
  const run = async () => {
    const selected = action()
    if (!selected || pending()) return
    setPending(true)
    setActionError(undefined)
    try {
      await props.onAction?.(selected)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : JSON.stringify(error))
    } finally {
      setPending(false)
    }
  }
  createEffect(() => {
    props.messageID
    props.error
    retry()?.phase
    setActionError(undefined)
  })
  const details = () =>
    [retry()?.error ?? JSON.stringify(props.error, null, 2), actionError()].filter(Boolean).join("\n\n")
  const progress = () => {
    const state = retry()
    if (!state?.next || state.phase === "connecting") return undefined
    return {
      value: Math.max(0, Math.min(100, (100 * (now() - state.startedAt)) / Math.max(1, state.next - state.startedAt))),
      label: description()!,
    }
  }
  return (
    <Show when={visible()}>
      <ErrorCard
        error={details()}
        summary={summary()}
        description={actionError() ?? description()}
        progress={progress()}
        actions={
          <Show when={action()}>
            <button type="button" data-slot="error-card-retry" disabled={pending()} onClick={() => void run()}>
              {actionLabel()}
            </button>
          </Show>
        }
      />
    </Show>
  )
}
