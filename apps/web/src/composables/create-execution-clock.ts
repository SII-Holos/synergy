import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"
import { ExecutionClock, type ExecutionSample } from "@/utils/execution-time"

export function createExecutionClock(sample: Accessor<ExecutionSample | undefined>, connected: Accessor<boolean>) {
  const clock = new ExecutionClock()
  const [advance, setAdvance] = createSignal(0)
  const update = () => setAdvance(clock.advance(performance.now()))
  createEffect(
    on(
      () => [sample()?.clockID, sample()?.sampledAt, sample()?.revision],
      () => {
        if (sample()) clock.accept(performance.now(), connected())
        update()
      },
    ),
  )
  createEffect(
    on(connected, (value) => {
      if (!value) clock.pause(performance.now())
      update()
    }),
  )
  const timer = setInterval(update, 1000)
  onCleanup(() => clearInterval(timer))
  return advance
}
