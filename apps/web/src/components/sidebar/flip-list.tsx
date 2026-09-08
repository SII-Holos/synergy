import { createRenderEffect, on, onMount, type JSX } from "solid-js"
import { createFlipRunner } from "./flip-list-model"

export function FlipList(props: {
  entries: readonly unknown[]
  children: JSX.Element
  class?: string
  selector?: string
  dataKey?: string
}) {
  let container: HTMLDivElement | undefined
  const reduceMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  const runFlip = createFlipRunner({
    selector: props.selector,
    dataKey: props.dataKey,
    reduceMotion,
  })

  // The render effect fires once at mount before the container ref is
  // assigned, so that pass is skipped by the runner (see flip-list-model).
  // Seed the baseline from onMount instead, once the ref and its rows are in
  // the DOM, so the first genuine entries change animates new or repositioned
  // rows instead of being absorbed as a silent baseline.
  onMount(() => {
    runFlip(container)
  })

  createRenderEffect(
    on(
      () => props.entries,
      () => runFlip(container),
    ),
  )

  return (
    <div ref={container!} class={props.class}>
      {props.children}
    </div>
  )
}
