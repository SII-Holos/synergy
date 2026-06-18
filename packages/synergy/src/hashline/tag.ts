export function normalizeContent(content: string): string {
  return content
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/[ \t]+(?=\n|$)/g, "")
}
export function splitContentLines(content: string): string[] {
  const normalized = normalizeContent(content)
  if (normalized === "") return []
  const lines = normalized.split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines
}

export function computeTag(content: string): string {
  const normalized = normalizeContent(content)
  const low16 = Bun.hash.xxHash32(normalized, 0) & 0xffff
  return low16.toString(16).padStart(4, "0").toUpperCase()
}
