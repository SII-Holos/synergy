import { Show, createSignal, onCleanup } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { useLingui } from "@lingui/solid"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import type { PluginInputService } from "@ericsanchezok/synergy-plugin"
import { ComposerResizeGesture, composerBodyLimits, composerPresentation } from "./composer-presentation"

export function ComposerExpandButton(props: { input: Pick<PluginInputService, "current">; availableHeight: number }) {
  const binding = composerPresentation(props.input)
  const { _ } = useLingui()
  const [version, setVersion] = createSignal(0)
  if (binding) onCleanup(binding.state.subscribe(() => setVersion((value) => value + 1)))
  const expanded = () => {
    version()
    return !!binding?.state.expanded
  }
  // Below 768 pixels, and for coarse pointers, this control is the only sizing
  // affordance: it drags to resize and taps to expand. It already sits inside
  // the editor's `pr-12` gutter, so the target never covers a character and the
  // card keeps four interactive targets instead of five.
  const merged = createMediaQuery("(max-width: 767px), (pointer: coarse)")
  let root: HTMLDivElement | undefined
  let gesture: ComposerResizeGesture | undefined
  let pointer: number | undefined
  let originalHeight: number | undefined
  let dragged = false
  const form = () => root?.closest("form")
  const editor = () => form()?.querySelector<HTMLElement>(".session-composer-editor")
  const limits = () => {
    version()
    const target = form()
    const body = editor()
    const chrome = target && body ? target.getBoundingClientRect().height - body.getBoundingClientRect().height : 80
    return composerBodyLimits(props.availableHeight, chrome, binding?.hasAttachments?.(), binding?.state.manualHeight)
  }
  const resize = (delta: number) => {
    const { minimum, manual } = limits()
    const current = editor()?.getBoundingClientRect().height ?? minimum
    binding?.state.setHeight(Math.min(manual, Math.max(minimum, current + delta)))
  }
  const cancel = () => {
    if (!gesture) return
    gesture = undefined
    pointer = undefined
    binding?.state.setHeight(originalHeight)
  }
  const toggle = () => {
    if (expanded()) binding?.state.collapse()
    else binding?.state.expand()
  }
  return (
    <Show when={binding && props.input.current().mode === "normal"}>
      <div class="composer-expand-region" ref={root} data-merged={merged() ? "" : undefined}>
        <Tooltip
          value={
            expanded()
              ? _({ id: "prompt.long.collapse", message: "Collapse editor" })
              : _({ id: "prompt.long.expand", message: "Expand editor" })
          }
        >
          <button
            type="button"
            class="composer-expand-control"
            aria-label={
              expanded()
                ? _({ id: "prompt.long.collapse", message: "Collapse editor" })
                : _({ id: "prompt.long.expand", message: "Expand editor" })
            }
            aria-description={
              merged()
                ? _({ id: "prompt.long.expandDescription", message: "Drag up or down to resize the editor" })
                : undefined
            }
            aria-expanded={expanded()}
            onPointerDown={(event) => {
              if (!merged() || event.button !== 0 || gesture) return
              pointer = event.pointerId
              originalHeight = binding?.state.manualHeight
              const { minimum, manual } = limits()
              gesture = new ComposerResizeGesture({
                y: event.clientY,
                height: editor()?.getBoundingClientRect().height ?? minimum,
                maximum: manual,
                minimum,
              })
              dragged = false
              event.currentTarget.setPointerCapture(event.pointerId)
            }}
            onPointerMove={(event) => {
              if (!gesture || event.pointerId !== pointer) return
              if (!dragged && Math.abs(event.clientY - gesture.initial.y) <= 3) return
              dragged = true
              event.preventDefault()
              const next = gesture.move(event.clientY)
              if (next.height !== binding?.state.manualHeight) binding?.state.setHeight(next.height)
            }}
            onPointerUp={(event) => {
              if (!gesture || event.pointerId !== pointer) return
              const moved = dragged
              gesture = undefined
              pointer = undefined
              if (moved) return
              binding?.state.setHeight(originalHeight)
              toggle()
            }}
            onPointerCancel={cancel}
            onLostPointerCapture={cancel}
            onClick={(event) => {
              // A merged layout already acted on pointer up, so only the
              // keyboard-synthesised click (detail 0) may toggle here; ignoring
              // it would drop Enter and Space.
              if (merged() && event.detail !== 0) return
              toggle()
            }}
            onKeyDown={(event) => {
              if (!merged()) return
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
            }}
          >
            <Icon name={getSemanticIcon(expanded() ? "action.collapse" : "action.expand")} size="small" />
          </button>
        </Tooltip>
      </div>
    </Show>
  )
}
