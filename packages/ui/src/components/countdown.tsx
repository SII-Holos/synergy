import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { COUNTDOWN_DESC } from "./tool-title-descriptors"
import type { CountdownKind } from "./tool/timeout"

export interface CountdownProps {
  seconds: number
  active: boolean
  /** Server-provided start of the window. Without it nothing is rendered:
   *  a countdown is a claim about elapsed time, and mount time is not that
   *  claim's origin (a remount would restart it from full). */
  startedAt?: number
  kind?: CountdownKind
}

export function Countdown(props: CountdownProps) {
  const { _ } = useLingui()
  const [now, setNow] = createSignal(Date.now())

  createEffect(() => {
    if (!props.active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  const startedAt = () =>
    typeof props.startedAt === "number" && Number.isFinite(props.startedAt) ? props.startedAt : undefined
  const remaining = () => Math.max(0, Math.ceil(((startedAt() ?? 0) + props.seconds * 1000 - now()) / 1000))
  const ratio = () => (props.seconds > 0 ? remaining() / props.seconds : 0)
  const kind = () => props.kind ?? "remaining"
  const expired = () => props.active && remaining() <= 0

  const label = () => {
    const value = remaining()
    if (value > 0) {
      const descriptor =
        kind() === "auto_background"
          ? COUNTDOWN_DESC.toBackground
          : kind() === "timeout"
            ? COUNTDOWN_DESC.toTimeout
            : COUNTDOWN_DESC.remaining
      return { ...descriptor, values: { remaining: value } }
    }
    return kind() === "auto_background"
      ? COUNTDOWN_DESC.backgrounded
      : kind() === "timeout"
        ? COUNTDOWN_DESC.timedOut
        : COUNTDOWN_DESC.pastLimit
  }

  return (
    <Show when={props.active && startedAt() !== undefined}>
      <span data-component="countdown" data-urgent={ratio() <= 0.2} data-expired={expired()}>
        {_(label())}
      </span>
    </Show>
  )
}
