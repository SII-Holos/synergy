import { createSignal, onCleanup, Show } from "solid-js"

export interface CountdownProps {
  seconds: number
  active: boolean
}

export function Countdown(props: CountdownProps) {
  const [elapsed, setElapsed] = createSignal(0)

  const timer = setInterval(() => {
    if (props.active) setElapsed((e) => e + 1)
  }, 1000)

  onCleanup(() => clearInterval(timer))

  const remaining = () => Math.max(0, props.seconds - elapsed())
  const ratio = () => remaining() / props.seconds
  const expired = () => props.active && remaining() <= 0

  return (
    <Show when={props.active}>
      <span data-component="countdown" data-urgent={ratio() <= 0.2} data-expired={expired()}>
        {remaining()}s
      </span>
    </Show>
  )
}
