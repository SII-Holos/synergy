export function attachmentRowBoundary(boxes: Array<{ top: number; bottom: number }>) {
  const tops: number[] = []
  for (const box of boxes) if (!tops.some((top) => Math.abs(top - box.top) < 1)) tops.push(box.top)
  if (tops.length <= 2) return { visible: boxes.length, height: undefined }
  const visible = boxes.filter((box) => box.top < tops[2]! - 0.5)
  return { visible: visible.length, height: Math.max(...visible.map((box) => box.bottom)) }
}
