function cleanReasoningLine(line: string): string | undefined {
  const trimmed = line.trim()
  if (!trimmed || /^(`{3,}|~{3,})\S*$/.test(trimmed) || /^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) return undefined
  return trimmed.replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "").trim()
}

/** The latest non-structural line of reasoning markdown, with markup prefixes stripped. */
export function compactReasoningText(text: string): string {
  const lines = text.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = cleanReasoningLine(lines[index] ?? "")
    if (line) return line
  }
  return ""
}

/** The first non-structural line of reasoning markdown, for settled summaries. */
export function compactReasoningFirstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const cleaned = cleanReasoningLine(line)
    if (cleaned) return cleaned
  }
  return ""
}
