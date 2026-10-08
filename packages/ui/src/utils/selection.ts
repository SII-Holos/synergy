// Provenance: https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/editing/dom_selection.cc
// Local adaptation: Range.collapsed uses DOM endpoints; Selection.isCollapsed synchronously updates layout.
export function readSelectionRanges(document: Document): Range[] {
  const selection = document.getSelection()
  const ranges: Range[] = []
  const count = selection?.rangeCount ?? 0
  for (let index = 0; index < count; index++) {
    const range = selection!.getRangeAt(index)
    if (!range.collapsed) ranges.push(range)
  }
  return ranges
}

export function readSelectionElements(root: HTMLElement, selector: string): HTMLElement[] {
  const ranges = readSelectionRanges(root.ownerDocument)
  if (!ranges.length) return []
  return [...root.querySelectorAll<HTMLElement>(selector)].filter((element) =>
    ranges.some((range) => range.intersectsNode(element)),
  )
}
