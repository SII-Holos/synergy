/**
 * Convert a viewport measurement from browser pixels to the layout coordinate
 * space used by elements below a CSS zoom root.
 */
export function layoutSizeForZoom(size: number, zoom: number): number {
  if (!Number.isFinite(size) || !Number.isFinite(zoom) || zoom <= 0) return size
  return size / zoom
}
