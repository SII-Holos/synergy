export const TOOL_PREVIEW_BYTES = 8 * 1024
export const TOOL_PREVIEW_LINES = 80

export function previewToolContent(text: string, range?: { offset?: number; limit?: number }) {
  const offset = Math.max(0, Math.floor(range?.offset ?? 0))
  const limit = Math.max(0, Math.floor(range?.limit ?? Infinity))
  let start = 0
  for (let line = 0; line < offset; line++) {
    const next = text.indexOf("\n", start)
    if (next < 0) return { text: "", truncated: false }
    start = next + 1
  }
  let end = start
  let bytes = 0
  let lines = 1
  while (end < text.length && limit > 0) {
    const code = text.codePointAt(end)!
    if (code === 10 && lines >= Math.min(limit, TOOL_PREVIEW_LINES)) break
    const size = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4
    if (bytes + size > TOOL_PREVIEW_BYTES) break
    bytes += size
    if (code === 10) lines++
    end += code > 0xffff ? 2 : 1
  }
  const rangeComplete = limit === 0 || (text[end] === "\n" && lines >= limit)
  return { text: text.slice(start, end), truncated: end < text.length && !rangeComplete }
}
