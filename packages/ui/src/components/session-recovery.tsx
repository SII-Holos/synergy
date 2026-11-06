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
  // Only local backoff owns a deadline, so it is the only wait this card can
  // count down. Provider admission and the in-flight attempt belong to the
  // activity header; rendering them here would claim a deadline that any
  // concurrent failure can push back.
  const countdown = createMemo(() => (retry()?.phase === "waiting" ? retry() : undefined))
  // A terminal failure keeps its evidence until this same turn runs again. The
  // retry is the acknowledgement, and the header names it meanwhile; a newer
  // turn running elsewhere must not erase an older failure.
  const terminal = () => {
    if (retry() || !props.error) return undefined
    if (props.status?.type !== "busy") return props.error
    if (props.current || props.status.activity?.rootID === props.rootID) return undefined
    return props.error
  }
  const visible = () => !!countdown() || !!terminal()
  createEffect(() => {
    setNow(Date.now())
    if (!active() || countdown()?.next === undefined) return
    const timer = setInterval(() => setNow(Date.now()), 250)
    onCleanup(() => clearInterval(timer))
  })
  const seconds = () => Math.max(0, Math.ceil(((countdown()?.next ?? now()) - now()) / 1000))
  const summary = () => {
    const state = countdown()
    if (state) return errorPreview(state.message)
    return (
      props.summary ??
      (props.error && "message" in props.error.data
        ? errorPreview(String(props.error.data.message))
        : _({ id: "ui.recovery.failed", message: "Request failed" }))
    )
  }
  const description = () => {
    const state = countdown()
    if (!state?.next) return undefined
    if (seconds() === 0) return _({ id: "ui.recovery.starting", message: "Preparing to retry" })
    // `wait()` is only reached after the attempt counter advances, so a
    // countdown always belongs to a numbered attempt.
    return _({
      id: "ui.recovery.countdownAttempt",
      message: "Retry {attempt} · Automatically retrying in {seconds}s",
      values: { attempt: state.attempt, seconds: seconds() },
    })
  }
  const action = createMemo<SessionRecoveryAction | undefined>(() => {
    if (!props.onAction || !props.current || props.status?.type === "busy") return
    const state = countdown()
    if (state)
      return state.canRetry ? { kind: "retry", sessionID: props.sessionID, messageID: state.messageID } : undefined
    // A terminal failure offers only the repairs a new message cannot reach:
    // re-authenticating, or choosing a model that exists. An exhausted retry
    // budget restarts by sending a message, so it gets no button.
    const error = props.error
    if (error?.name === "ProviderAuthError")
      return { kind: "authenticate", sessionID: props.sessionID, providerID: error.data.providerID }
    if (error?.name === "ProviderModelUnavailableError" || error?.name === "ProviderModelVariantUnavailableError")
      return { kind: "select_model", sessionID: props.sessionID }
    if (error?.name !== "APIError") return
    if (error.data.statusCode === 401 && props.providerID)
      return { kind: "authenticate", sessionID: props.sessionID, providerID: props.providerID }
  })
  const actionLabel = () => {
    const selected = action()
    switch (selected?.kind) {
      case "retry":
        return _({ id: "ui.recovery.retryNow", message: "Retry now" })
      case "authenticate":
        return _({ id: "ui.recovery.reconnect", message: "Reconnect" })
      case "select_model":
        return _({ id: "ui.recovery.selectModel", message: "Choose model" })
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
    props.error
    retry()?.phase
    setActionError(undefined)
  })
  const details = () =>
    [countdown()?.error ?? JSON.stringify(props.error, null, 2), actionError()].filter(Boolean).join("\n\n")
  const progress = () => {
    const state = countdown()
    if (!state?.next) return undefined
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
