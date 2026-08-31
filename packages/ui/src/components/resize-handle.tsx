import { splitProps, type JSX } from "solid-js"
import { resolveSeparatorKeyboardSize } from "./resize-handle-model"

export interface ResizeHandleProps extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "onResize"> {
  direction: "horizontal" | "vertical"
  edge?: "start" | "end"
  size: number
  min: number
  max: number
  onResize: (size: number) => void
  onResizeStart?: () => void
  onResizeEnd?: () => void
  onCollapse?: () => void
  collapseThreshold?: number
}

export function ResizeHandle(props: ResizeHandleProps) {
  const [local, rest] = splitProps(props, [
    "direction",
    "edge",
    "size",
    "min",
    "max",
    "onResize",
    "onResizeStart",
    "onResizeEnd",
    "onCollapse",
    "collapseThreshold",
    "class",
    "classList",
  ])

  const handleKeyDown = (event: KeyboardEvent & { currentTarget: HTMLDivElement }) => {
    const next = resolveSeparatorKeyboardSize(event.key, {
      size: local.size,
      min: local.min,
      max: local.max,
      direction: local.direction,
      edge: local.edge,
    })
    if (next === undefined) return
    event.preventDefault()
    local.onResize(next)
  }

  const handlePointerDown = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    if (event.pointerType === "mouse" && event.button !== 0) return
    const start = local.direction === "horizontal" ? event.clientX : event.clientY
    const startSize = local.size
    let current = startSize

    document.body.style.userSelect = "none"
    document.body.style.overflow = "hidden"
    event.currentTarget.setPointerCapture(event.pointerId)
    local.onResizeStart?.()

    const edge = local.edge ?? "end"
    const onPointerMove = (moveEvent: PointerEvent) => {
      const pos = local.direction === "horizontal" ? moveEvent.clientX : moveEvent.clientY
      const delta = edge === "start" ? start - pos : pos - start
      current = startSize + delta
      const clamped = Math.min(local.max, Math.max(local.min, current))
      local.onResize(clamped)
    }

    const finish = () => {
      document.body.style.userSelect = ""
      document.body.style.overflow = ""
      document.removeEventListener("pointermove", onPointerMove)
      document.removeEventListener("pointerup", onPointerUp)
      document.removeEventListener("pointercancel", onPointerCancel)
      local.onResizeEnd?.()
    }

    const onPointerUp = () => {
      finish()
      const threshold = local.collapseThreshold ?? 0
      if (local.onCollapse && threshold > 0 && current < threshold) {
        local.onCollapse()
      }
    }

    const onPointerCancel = () => {
      finish()
    }

    document.addEventListener("pointermove", onPointerMove)
    document.addEventListener("pointerup", onPointerUp)
    document.addEventListener("pointercancel", onPointerCancel)
  }

  return (
    <div
      {...rest}
      data-component="resize-handle"
      data-direction={local.direction}
      data-edge={local.edge ?? "end"}
      role="separator"
      tabIndex={0}
      aria-orientation={local.direction === "horizontal" ? "vertical" : "horizontal"}
      aria-valuemin={local.min}
      aria-valuemax={local.max}
      aria-valuenow={local.size}
      classList={{
        ...(local.classList ?? {}),
        [local.class ?? ""]: !!local.class,
      }}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
    />
  )
}
