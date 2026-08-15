import { splitProps, type JSX } from "solid-js"

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
  /** Scale applied by an ancestor CSS zoom when converting pointer deltas. */
  coordinateScale?: number
}

export function ResizeHandle(props: ResizeHandleProps) {
  const [local, rest] = splitProps(props, [
    "direction",
    "size",
    "edge",
    "min",
    "max",
    "onResize",
    "onResizeStart",
    "onResizeEnd",
    "onCollapse",
    "collapseThreshold",
    "coordinateScale",
    "class",
    "classList",
  ])

  const handleMouseDown = (e: MouseEvent) => {
    e.preventDefault()
    const start = local.direction === "horizontal" ? e.clientX : e.clientY
    const startSize = local.size
    let current = startSize

    document.body.style.userSelect = "none"
    document.body.style.overflow = "hidden"
    local.onResizeStart?.()

    const edge = local.edge ?? "end"
    const onMouseMove = (moveEvent: MouseEvent) => {
      const pos = local.direction === "horizontal" ? moveEvent.clientX : moveEvent.clientY
      const rawDelta = edge === "start" ? start - pos : pos - start
      const coordinateScale =
        typeof local.coordinateScale === "number" && local.coordinateScale > 0 ? local.coordinateScale : 1
      const delta = rawDelta / coordinateScale
      current = startSize + delta
      const clamped = Math.min(local.max, Math.max(local.min, current))
      local.onResize(clamped)
    }

    const onMouseUp = () => {
      document.body.style.userSelect = ""
      document.body.style.overflow = ""
      document.removeEventListener("mousemove", onMouseMove)
      document.removeEventListener("mouseup", onMouseUp)
      local.onResizeEnd?.()

      const threshold = local.collapseThreshold ?? 0
      if (local.onCollapse && threshold > 0 && current < threshold) {
        local.onCollapse()
      }
    }

    document.addEventListener("mousemove", onMouseMove)
    document.addEventListener("mouseup", onMouseUp)
  }

  return (
    <div
      {...rest}
      data-component="resize-handle"
      data-direction={local.direction}
      data-edge={local.edge ?? "end"}
      classList={{
        ...(local.classList ?? {}),
        [local.class ?? ""]: !!local.class,
      }}
      onMouseDown={handleMouseDown}
    />
  )
}
