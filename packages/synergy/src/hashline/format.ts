import { normalizeContent } from "./tag"

export function formatHashline(filePath: string, tag: string): string {
  return `[${filePath}#${tag}]`
}

export function formatHashlineLine(lineNumber: number, text: string): string {
  return `${lineNumber}:${text}`
}

export function contentLines(content: string): string[] {
  const normalized = normalizeContent(content)
  if (normalized === "") return []
  const lines = normalized.split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines
}

export function formatNumberedLines(content: string, startLine = 1): string {
  return contentLines(content)
    .map((line, index) => formatHashlineLine(startLine + index, line))
    .join("\n")
}

export function formatHashlineBlock(filePath: string, tag: string, content: string): string {
  const body = formatNumberedLines(content)
  return body ? `${formatHashline(filePath, tag)}\n${body}` : `${formatHashline(filePath, tag)}\n`
}

function bodyHasTrailingNewline(lines: string[]): boolean {
  return lines.length > 1 && lines.at(-1) === ""
}

export function stripHashlineDisplayPrefixes(content: string): string {
  const normalized = normalizeContent(content)
  const lines = normalized.split("\n")
  if (!lines[0]?.match(/^\[[^\]\n#]+#[0-9A-F]{4}\]$/)) return content

  const hasTrailingNewline = bodyHasTrailingNewline(lines)
  const body = hasTrailingNewline ? lines.slice(1, -1) : lines.slice(1)
  const displayLinePattern = /^(\d+):(.*)$/
  const numbered = body.map((line) => line.match(displayLinePattern))
  if (numbered.some((match) => !match)) return content
  if (numbered.some((match, index) => Number(match?.[1]) !== index + 1)) return content
  return numbered.map((match) => match?.[2] ?? "").join("\n") + (hasTrailingNewline ? "\n" : "")
}
