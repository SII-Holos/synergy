export function markdownScrollViewport(root: HTMLElement): HTMLElement | undefined {
  let native: HTMLElement | undefined
  for (let parent = root.parentElement; parent; parent = parent.parentElement) {
    if (parent.dataset.scrollViewport === "vertical") return parent
    if (native) continue
    // CSS Overflow 3 makes overflow-y: visible compute to auto when x scrolls.
    // https://www.w3.org/TR/css-overflow-3/#overflow-properties
    const overflow = parent.ownerDocument.defaultView!.getComputedStyle(parent).overflowY
    if ((overflow === "auto" || overflow === "scroll") && parent.scrollHeight > parent.clientHeight) native = parent
  }
  return native
}
