import { createSignal, onCleanup, Show } from "solid-js"

export interface CountdownProps {
  seconds: number
  active: boolean
  startedAt?: number
}

export function Countdown(props: CountdownProps) {
  const fallbackStartedAt = Date.now()
  const [now, setNow] = createSignal(Date.now())

  const timer = setInterval(() => {
    if (props.active) setNow(Date.now())
  }, 1000)

  onCleanup(() => clearInterval(timer))

  const startedAt = () => props.startedAt ?? fallbackStartedAt
  const remaining = () => Math.max(0, Math.ceil((startedAt() + props.seconds * 1000 - now()) / 1000))
  const ratio = () => (props.seconds > 0 ? remaining() / props.seconds : 0)
  const expired = () => props.active && remaining() <= 0

  return (
    <Show when={props.active}>
      <span data-component="countdown" data-urgent={ratio() <= 0.2} data-expired={expired()}>
        {remaining()}s
      </span>
    </Show>
  )
}
