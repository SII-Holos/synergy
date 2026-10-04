import { translateDescriptor } from "@/locales/translate"
import { ErrorBoundary, Show, Suspense, createEffect, createResource, createSignal, onCleanup, onMount } from "solid-js"
import { Dynamic, Portal } from "solid-js/web"
import { createMediaQuery } from "@solid-primitives/media"
import { useLocale } from "@/context/locale"
import type { WelcomeMemory, WelcomeSceneDefinition } from "./types"
import { AmbientField } from "./ambient"
import "./style.css"

export function WelcomeStage(props: {
  definition: WelcomeSceneDefinition
  seed: number
  memory: WelcomeMemory
  blocked: boolean
}) {
  const { i18n } = useLocale()
  const reducedMotion = createMediaQuery("(prefers-reduced-motion: reduce)")
  const [paused, setPaused] = createSignal(reducedMotion())
  const [editing, setEditing] = createSignal(false)
  const [visible, setVisible] = createSignal(document.visibilityState !== "hidden")
  const [intersecting, setIntersecting] = createSignal(true)
  const [expanded, setExpanded] = createSignal(false)
  const [scene, { refetch }] = createResource(
    () => props.definition,
    (definition) => definition.load(),
  )
  let root!: HTMLDivElement
  const [pane, setPane] = createSignal<Element>()
  const interact = () => {
    setPaused(false)
    setEditing(false)
  }
  const gameActive = () => !paused() && !editing() && visible() && intersecting() && !expanded() && !props.blocked
  createEffect(() => {
    if (reducedMotion()) setPaused(true)
  })
  onMount(() => {
    const visibility = () => setVisible(document.visibilityState !== "hidden")
    const input = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('[data-component="prompt-input"]')) setEditing(true)
    }
    let keyboardNavigation = false
    const navigation = (event: KeyboardEvent) => {
      keyboardNavigation = event.key === "Tab"
    }
    const focus = (event: FocusEvent) => {
      if (keyboardNavigation && event.target instanceof Node && !root.contains(event.target)) setEditing(true)
    }
    const outside = (event: Event) => {
      keyboardNavigation = false
      if (
        !(event.target instanceof Element) ||
        !root.contains(event.target) ||
        !event.target.closest(".welcome-game-canvas, .welcome-game-status")
      )
        setEditing(true)
    }
    document.addEventListener("keydown", navigation, true)
    document.addEventListener("focusin", focus, true)
    document.addEventListener("pointerdown", outside, true)
    document.addEventListener("visibilitychange", visibility)
    document.addEventListener("input", input, true)
    document.addEventListener("compositionstart", input, true)
    let observed: Element | undefined
    const observer = new IntersectionObserver((entries) => {
      const entry = entries.find((item) => item.target === observed)
      if (entry) setIntersecting(entry.isIntersecting)
    })
    const observeVisual = () => {
      const next = root.querySelector("[data-welcome-visual]") ?? root
      if (next === observed) return
      if (observed) observer.unobserve(observed)
      observed = next
      observer.observe(next)
    }
    const visualChanges = new MutationObserver(observeVisual)
    visualChanges.observe(root, { subtree: true, childList: true })
    observeVisual()
    const pane = root.closest(".session-workbench-pane")
    setPane(pane ?? root)
    const measureExpanded = () => setExpanded(!!pane?.querySelector(".session-composer[data-expanded]"))
    const mutation = new MutationObserver(measureExpanded)
    if (pane) mutation.observe(pane, { subtree: true, attributes: true, attributeFilter: ["data-expanded"] })
    measureExpanded()
    onCleanup(() => {
      document.removeEventListener("keydown", navigation, true)
      document.removeEventListener("focusin", focus, true)
      document.removeEventListener("pointerdown", outside, true)
      document.removeEventListener("visibilitychange", visibility)
      document.removeEventListener("input", input, true)
      document.removeEventListener("compositionstart", input, true)
      observer.disconnect()
      visualChanges.disconnect()
      mutation.disconnect()
    })
  })
  return (
    <div
      ref={root}
      class="welcome-stage"
      data-welcome-scene={props.definition.id}
      data-prevent-autofocus
      data-active={gameActive() ? "" : undefined}
    >
      <Show when={pane()}>
        {(target) => (
          <Portal mount={target()}>
            <AmbientField seed={props.seed} active={visible} reducedMotion={reducedMotion} />
          </Portal>
        )}
      </Show>
      <div class="welcome-scene-heading">
        <h1>{i18n._({ id: "welcome.common.title", message: "Bring your ideas to life." })}</h1>
        <p>
          {i18n._({
            id: "welcome.common.subtitle",
            message: "From a spark to something real. What will you create?",
          })}
        </p>
      </div>
      <ErrorBoundary
        fallback={(_error, reset) => (
          <div class="welcome-unavailable" role="status">
            <h2>{translateDescriptor(props.definition.title, i18n)}</h2>
            <p>
              {i18n._({
                id: "welcome.common.unavailable",
                message: "This example could not load. You can still start a task below.",
              })}
            </p>
            <button
              type="button"
              onClick={() => {
                void refetch()
                reset()
              }}
            >
              {i18n._({ id: "welcome.common.retry", message: "Retry example" })}
            </button>
          </div>
        )}
      >
        <Suspense
          fallback={
            <div class="welcome-loading" role="status">
              <h2>{translateDescriptor(props.definition.title, i18n)}</h2>
              <p>{i18n._({ id: "welcome.common.loading", message: "Preparing an interactive example…" })}</p>
            </div>
          }
        >
          <Show when={scene()}>
            {(loaded) => (
              <Dynamic
                component={loaded().default}
                seed={props.seed}
                active={gameActive}
                reducedMotion={reducedMotion}
                memory={props.memory}
                interact={interact}
                pause={() => setPaused(true)}
              />
            )}
          </Show>
        </Suspense>
      </ErrorBoundary>
    </div>
  )
}
