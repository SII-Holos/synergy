import { useLingui } from "@lingui/solid"
import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js"
import {
  finishActivityCountTransition,
  reduceActivityCountTransition,
  type ActivityCountTransition,
} from "./activity-count-transition"
import "./animated-activity-count.css"

const TRANSITION_MS = 180

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

export function AnimatedActivityCount(props: { value: number; identity: string; animate?: boolean }) {
  const { i18n } = useLingui()
  const format = (value: number) => i18n().number(value)
  const reduced = typeof window !== "undefined" ? window.matchMedia?.("(prefers-reduced-motion: reduce)") : undefined
  const [state, setState] = createSignal<ActivityCountTransition>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let element: HTMLSpanElement | undefined
  let widthMotion: Animation | undefined
  const identity = createMemo(() => `${props.identity}:${i18n().locale}`)
  const value = createMemo(() => props.value)
  const animate = createMemo(() => props.animate !== false)

  const cancelTimer = () => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
  }

  createEffect(
    on([identity, value, animate], ([identity, value]) => {
      const width = element?.getBoundingClientRect().width
      widthMotion?.cancel()
      cancelTimer()
      const next = reduceActivityCountTransition(state(), {
        identity,
        value,
        reducedMotion: props.animate === false || prefersReducedMotion(),
      })
      setState(next)
      if (!next.animating) return
      const targetWidth = element?.getBoundingClientRect().width
      if (width && targetWidth && width !== targetWidth && element?.animate) {
        widthMotion = element.animate([{ width: `${width}px` }, { width: `${targetWidth}px` }], {
          duration: TRANSITION_MS,
          easing: "cubic-bezier(0.2, 0, 0, 1)",
        })
      }
      const revision = next.revision
      timer = setTimeout(() => {
        setState((current) => (current ? finishActivityCountTransition(current, revision) : current))
        timer = undefined
      }, TRANSITION_MS)
    }),
  )

  const settle = () => {
    if (!reduced?.matches) return
    cancelTimer()
    widthMotion?.cancel()
    setState((current) => (current ? finishActivityCountTransition(current, current.revision) : current))
  }
  reduced?.addEventListener?.("change", settle)
  onCleanup(() => {
    cancelTimer()
    widthMotion?.cancel()
    reduced?.removeEventListener?.("change", settle)
  })

  return (
    <span
      ref={element}
      data-component="animated-activity-count"
      data-animating={state()?.animating ? "" : undefined}
      aria-label={format(props.value)}
    >
      <span data-slot="activity-count-grid" aria-hidden="true">
        <Show when={state()?.animating && state()?.previous !== undefined}>
          <span data-slot="activity-count-old">{format(state()!.previous!)}</span>
        </Show>
        <span data-slot="activity-count-new">{format(state()?.current ?? props.value)}</span>
      </span>
    </span>
  )
}
