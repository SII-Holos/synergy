import { Show, createEffect, createSignal, onCleanup } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { PluginInputService } from "@ericsanchezok/synergy-plugin"
import { ComposerResizeGesture, composerBodyLimits, composerPresentation } from "./composer-presentation"

export function ComposerResizeControls(props: { input: Pick<PluginInputService, "current">; availableHeight: number }) {
  const binding = composerPresentation(props.input)
  const { _ } = useLingui()
  const [version, setVersion] = createSignal(0)
  if (binding) onCleanup(binding.state.subscribe(() => setVersion((value) => value + 1)))
  const expanded = () => {
    version()
    return binding?.state.expanded
  }
  const [armed, setArmed] = createSignal(false)
  const [progress, setProgress] = createSignal(0)
  const [pull, setPull] = createSignal(0)
  const [chromeHeight, setChromeHeight] = createSignal(80)
  const [handle, setHandle] = createSignal<HTMLButtonElement>()
  let gesture: ComposerResizeGesture | undefined
  let pointer: number | undefined
  let originalHeight: number | undefined
  let moved = false
  const editor = () => handle()?.closest("form")?.querySelector<HTMLElement>(".session-composer-editor")
  createEffect(() => {
    const form = handle()?.closest("form")
    const body = form?.querySelector<HTMLElement>(".session-composer-editor")
    if (!form || !body) return
    const measure = () => setChromeHeight(form.getBoundingClientRect().height - body.getBoundingClientRect().height)
    const observer = new ResizeObserver(measure)
    observer.observe(form)
    observer.observe(body)
    measure()
    onCleanup(() => observer.disconnect())
  })
  const limits = () => composerBodyLimits(props.availableHeight, chromeHeight())
  const resize = (delta: number) => {
    const { minimum, manual } = limits()
    binding?.state.setHeight(
      Math.min(manual, Math.max(minimum, (editor()?.getBoundingClientRect().height ?? minimum) + delta)),
    )
  }
  const cancel = () => {
    if (!gesture) return
    gesture = undefined
    pointer = undefined
    binding?.state.setHeight(originalHeight)
    setArmed(false)
    setProgress(0)
    setPull(0)
  }
  const cancelKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !gesture) return
    event.preventDefault()
    event.stopPropagation()
    cancel()
  }
  document.addEventListener("keydown", cancelKey, true)
  onCleanup(() => {
    cancel()
    document.removeEventListener("keydown", cancelKey, true)
  })
  return (
    <Show when={binding && !expanded() && props.input.current().mode === "normal"}>
      <div
        class="composer-resize-controls"
        data-pull={progress() > 0 ? "" : undefined}
        data-armed={armed() ? "" : undefined}
        style={{ "--composer-expand-progress": progress(), "--composer-expand-pull": `${pull()}px` }}
      >
        <button
          type="button"
          role="separator"
          aria-orientation="horizontal"
          ref={setHandle}
          aria-label={_({ id: "prompt.long.resize", message: "Resize editor" })}
          aria-valuemin={limits().minimum}
          aria-valuemax={limits().manual}
          aria-valuenow={(version(), binding?.state.manualHeight ?? 96)}
          class="composer-resize-handle"
          onPointerDown={(event) => {
            if (event.button !== 0 || gesture) return
            event.preventDefault()
            pointer = event.pointerId
            originalHeight = binding?.state.manualHeight
            const { minimum, manual } = limits()
            gesture = new ComposerResizeGesture({
              y: event.clientY,
              height: editor()?.getBoundingClientRect().height ?? minimum,
              maximum: manual,
              minimum,
            })
            moved = false
            handle()?.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            if (!gesture || event.pointerId !== pointer) return
            moved ||= Math.abs(event.clientY - gesture.initial.y) > 3
            const next = gesture.move(event.clientY)
            if (next.height !== binding?.state.manualHeight) binding?.state.setHeight(next.height)
            setArmed(next.expand)
            setProgress(next.progress)
            setPull(next.pull)
          }}
          onPointerUp={(event) => {
            if (!gesture || event.pointerId !== pointer) return
            gesture = undefined
            pointer = undefined
            if (!moved) binding?.state.setHeight(originalHeight)
            if (armed()) binding?.state.expand()
            setArmed(false)
            setProgress(0)
            setPull(0)
          }}
          onPointerCancel={cancel}
          onLostPointerCapture={cancel}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault()
              resize(event.key === "ArrowUp" ? 32 : -32)
            }
            if (event.key === "Home") {
              event.preventDefault()
              binding?.state.setHeight(undefined)
            }
            if (event.key === "End") {
              event.preventDefault()
              binding?.state.setHeight(limits().manual)
            }
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault()
              binding?.state.expand()
            }
          }}
        >
          <span aria-hidden="true" />
        </button>
        <div class="composer-resize-cue" role="status">
          <Show when={progress() > 0}>
            <Icon name={getSemanticIcon("composer.expand")} size="small" aria-hidden="true" />
            <span>
              {armed()
                ? _({ id: "prompt.long.releaseExpand", message: "Release to expand" })
                : _({ id: "prompt.long.continueExpand", message: "Continue dragging to expand" })}
            </span>
          </Show>
        </div>
      </div>
    </Show>
  )
}
