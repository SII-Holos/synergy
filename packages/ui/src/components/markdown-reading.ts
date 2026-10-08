import type { MarkdownDocument } from "../context/markdown-document"
export function markdownReadingPoint(root: HTMLElement, document: MarkdownDocument, source: number) {
  const reading = document.reading
  if (!reading) return
  for (const owner of root.querySelectorAll<HTMLElement>("[data-markdown-reading]")) {
    const value = owner.dataset.markdownReading!
    if (!value.startsWith(reading.marker + ":")) continue
    const run = reading.runs[Number(value.slice(reading.marker.length + 1))]
    if (!run || source < run.source.start || source >= run.source.end) continue
    if (!run.spans) return owner.getBoundingClientRect().top
    const span = run.spans.find(
      (span) => span.source <= source && source < span.source + (span.sourceLength ?? span.length),
    )
    if (!span) continue
    let offset = span.offset + (span.sourceLength === undefined ? source - span.source : 0)
    const walker = root.ownerDocument.createTreeWalker(owner, root.ownerDocument.defaultView!.NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const text = walker.currentNode as Text
      if (offset >= text.length) {
        offset -= text.length
        continue
      }
      const range = root.ownerDocument.createRange()
      range.setStart(text, offset)
      range.setEnd(text, Math.min(text.length, offset + (text.data.codePointAt(offset)! > 0xffff ? 2 : 1)))
      return range.getBoundingClientRect().top
    }
  }
}
