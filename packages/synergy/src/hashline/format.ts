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

export function stripHashlineDisplayPrefixes(content: string): string {
  const lines = normalizeContent(content).split("\n")
  const withoutHeader = lines[0]?.match(/^\[[^\]\n#]+#[0-9A-F]{4}\]$/) ? lines.slice(1) : lines
  const displayLinePattern = /^\d+:(.*)$/
  if (!withoutHeader.some((line) => displayLinePattern.test(line))) return content
  return withoutHeader.map((line) => line.match(displayLinePattern)?.[1] ?? line).join("\n")
}
