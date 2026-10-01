import { Show, createSignal, onCleanup } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import type { PluginInputService } from "@ericsanchezok/synergy-plugin"
import { ToolbarSelectorPopover } from "@/components/toolbar-selector"
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
  const [handle, setHandle] = createSignal<HTMLButtonElement>()
  let gesture: ComposerResizeGesture | undefined
  let originalHeight: number | undefined
  let moved = false
  const editor = () => handle()?.closest("form")?.querySelector<HTMLElement>(".session-composer-editor")
  const limits = () =>
    composerBodyLimits(
      props.availableHeight,
      (handle()?.closest("form")?.getBoundingClientRect().height ?? 80) -
        (editor()?.getBoundingClientRect().height ?? 0),
    )
  const resize = (delta: number) => {
    const { minimum, manual } = limits()
    binding?.state.setHeight(
      Math.min(manual, Math.max(minimum, (editor()?.getBoundingClientRect().height ?? minimum) + delta)),
    )
  }
  const cancel = () => {
    if (!gesture) return
    gesture = undefined
    binding?.state.setHeight(originalHeight)
    setArmed(false)
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
      <div class="composer-resize-controls">
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
            if (event.button !== 0) return
            event.preventDefault()
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
            if (!gesture) return
            moved ||= Math.abs(event.clientY - gesture.initial.y) > 3
            const next = gesture.move(event.clientY)
            binding?.state.setHeight(next.height)
            setArmed(next.expand)
          }}
          onPointerUp={() => {
            if (!gesture) return
            gesture = undefined
            if (!moved) binding?.state.setHeight(originalHeight)
            if (armed()) binding?.state.expand()
            setArmed(false)
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
          {armed() ? _({ id: "prompt.long.releaseExpand", message: "Release to expand" }) : ""}
        </div>
        <ToolbarSelectorPopover
          title={_({ id: "prompt.long.size", message: "Editor size" })}
          placement="top-end"
          triggerAs={(triggerProps) => (
            <button
              {...triggerProps}
              type="button"
              class="composer-size-menu"
              aria-label={_({ id: "prompt.long.size", message: "Editor size" })}
            >
              <Icon name="ellipsis" size="small" />
            </button>
          )}
        >
          {(close) => (
            <div class="flex flex-col gap-1 p-1">
              <button
                type="button"
                class="p-2 text-start rounded-md hover:bg-surface-raised-base-hover"
                onClick={() => {
                  binding?.state.setHeight(undefined)
                  close()
                }}
              >
                {_({ id: "prompt.long.autoSize", message: "Automatic height" })}
              </button>
              <button
                type="button"
                class="p-2 text-start rounded-md hover:bg-surface-raised-base-hover"
                onClick={() => {
                  binding?.state.setHeight(limits().manual)
                  close()
                }}
              >
                {_({ id: "prompt.long.tallSize", message: "Taller editor" })}
              </button>
              <button
                type="button"
                class="p-2 text-start rounded-md hover:bg-surface-raised-base-hover"
                onClick={() => {
                  binding?.state.expand()
                  close()
                }}
              >
                {_({ id: "prompt.long.expand", message: "Expand editor" })}
              </button>
            </div>
          )}
        </ToolbarSelectorPopover>
      </div>
    </Show>
  )
}
