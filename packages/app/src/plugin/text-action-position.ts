export type TextActionPoint = { x: number; y: number }

export function placeTextActionSurface(
  anchor: TextActionPoint,
  surface: { width: number; height: number },
  viewport: { width: number; height: number },
): TextActionPoint {
  const x = Math.max(8, Math.min(anchor.x, viewport.width - surface.width - 8))
  const y =
    anchor.y + surface.height <= viewport.height - 8 ? Math.max(8, anchor.y) : Math.max(8, anchor.y - surface.height)
  return { x, y }
}
