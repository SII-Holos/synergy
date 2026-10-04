import { createComputed, createMemo, on, onCleanup, onMount, type JSX } from "solid-js"
import { createFlipRunner, type FlipSnapshot } from "./flip-list-model"

export function FlipList(props: {
  entries: readonly string[]
  children: JSX.Element
  class?: string
  selector?: string
  dataKey?: string
}) {
  let container: HTMLDivElement | undefined
  let mounted = false
  let frame: number | undefined
  let snapshot: FlipSnapshot | undefined
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)")
  const runFlip = createFlipRunner({
    selector: props.selector,
    dataKey: props.dataKey,
    reduceMotion: () => reduced.matches,
  })
  const identity = createMemo(() => props.entries, undefined, {
    equals: (previous, next) => previous.length === next.length && previous.every((id, index) => id === next[index]),
  })
  const cancel = () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
    snapshot = undefined
    runFlip.cancel()
  }
  const changedPreference = () => {
    if (reduced.matches) cancel()
  }
  reduced.addEventListener("change", changedPreference)
  onMount(() => {
    mounted = true
  })
  onCleanup(() => {
    cancel()
    reduced.removeEventListener("change", changedPreference)
  })

  // Capture before the keyed children update; viewport scrolling cancels out
  // because both measurements use the list's current origin.
  createComputed(
    on(identity, () => {
      if (!mounted || !container || reduced.matches) return
      snapshot ??= runFlip.capture(container)
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const before = snapshot
        frame = undefined
        snapshot = undefined
        if (container?.isConnected && before) runFlip.play(container, before)
      })
    }),
  )

  return (
    <div ref={container!} class={props.class}>
      {props.children}
    </div>
  )
}
