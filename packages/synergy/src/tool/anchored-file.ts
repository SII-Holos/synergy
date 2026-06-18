import * as fs from "fs"
import * as path from "path"
import { FileTime } from "../file/time"
import { Instance } from "../scope/instance"
import { formatHashline, formatHashlineBlock } from "../hashline/format"
import { SessionHashlineStore } from "../hashline/store"
import { recordSeenRanges, SessionSeenStore } from "../hashline/seen"
import { normalizeContent, splitContentLines } from "../hashline/tag"

export const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024
export const MIN_VIEW_LINES = 120
export const DEFAULT_VIEW_LINES = 2000
export const MAX_VIEW_LINES = 3000
export const DEFAULT_VIEW_BYTES = 50 * 1024
export const MAX_LINE_COLUMNS = 512

export function resolveFilePath(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(Instance.directory, filePath)
}

export function displayPath(filePath: string): string {
  const relative = path.relative(Instance.directory, filePath)
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : filePath
}

function isKnownBinaryPath(filePath: string): boolean {
  switch (path.extname(filePath).toLowerCase()) {
    case ".zip":
    case ".tar":
    case ".gz":
    case ".exe":
    case ".dll":
    case ".so":
    case ".class":
    case ".jar":
    case ".war":
    case ".7z":
    case ".bin":
    case ".dat":
    case ".pdf":
    case ".docx":
    case ".xlsx":
    case ".pptx":
    case ".doc":
    case ".xls":
    case ".ppt":
      return true
    default:
      return false
  }
}

export async function readTextFile(filePath: string): Promise<string> {
  const file = Bun.file(filePath)
  const stats = await file.stat().catch(() => undefined)
  if (!stats) throw new Error(`File not found: ${filePath}`)
  if (stats.isDirectory()) throw new Error(`Path is a directory, not a file: ${filePath}`)
  if (isKnownBinaryPath(filePath)) throw new Error(`Cannot read binary file: ${filePath}`)
  return file.text()
}

export async function readTextFileUnderSnapshotCap(filePath: string): Promise<string | undefined> {
  const file = Bun.file(filePath)
  const stats = await file.stat().catch(() => undefined)
  if (!stats) throw new Error(`File not found: ${filePath}`)
  if (stats.isDirectory()) throw new Error(`Path is a directory, not a file: ${filePath}`)
  if (isKnownBinaryPath(filePath)) throw new Error(`Cannot read binary file: ${filePath}`)
  if (stats.size > SNAPSHOT_MAX_BYTES) return undefined
  return file.text()
}

export function recordHashlineSnapshot(sessionID: string, filePath: string, content: string): string {
  return SessionHashlineStore.get(sessionID).record(filePath, normalizeContent(content))
}

export async function recordHashlineSnapshotIfSmall(sessionID: string, filePath: string): Promise<string | undefined> {
  const content = await readTextFileUnderSnapshotCap(filePath)
  if (content === undefined) return undefined
  return recordHashlineSnapshot(sessionID, filePath, content)
}

export function formatRecordedBlock(
  sessionID: string,
  filePath: string,
  content: string,
): { output: string; tag: string } {
  const normalized = normalizeContent(content)
  const tag = recordHashlineSnapshot(sessionID, filePath, normalized)
  return { output: formatHashlineBlock(displayPath(filePath), tag, normalized), tag }
}

export async function ensureParentDir(filePath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
}

export function markFileRead(sessionID: string, filePath: string): void {
  FileTime.read(sessionID, filePath)
}

export function hashlineHeaderFor(sessionID: string, filePath: string, content: string): string {
  const tag = recordHashlineSnapshot(sessionID, filePath, content)
  return formatHashline(displayPath(filePath), tag)
}

export function normalizeLineLimit(limit: number | undefined, fallback = DEFAULT_VIEW_LINES): number {
  return Math.min(Math.max(limit ?? fallback, 0), MAX_VIEW_LINES)
}

export function truncateLineForDisplay(line: string): { text: string; truncated: boolean } {
  if (line.length <= MAX_LINE_COLUMNS) return { text: line, truncated: false }
  return { text: `${line.slice(0, MAX_LINE_COLUMNS)}…`, truncated: true }
}

export function splitDisplayLines(content: string): string[] {
  return splitContentLines(content)
}

export function formatSelectedLine(lines: string[], lineNumber: number): { output: string; truncated: boolean } {
  const raw = lines[lineNumber - 1] ?? ""
  const line = truncateLineForDisplay(raw)
  return { output: `${lineNumber}:${line.text}`, truncated: line.truncated }
}

export function formatSelectedLines(
  lines: string[],
  lineNumbers: number[],
): { output: string; truncatedLines: number[] } {
  const unique = [...new Set(lineNumbers)].filter((line) => line >= 1 && line <= lines.length).sort((a, b) => a - b)
  const truncatedLines: number[] = []
  const output = unique
    .map((lineNumber) => {
      const line = formatSelectedLine(lines, lineNumber)
      if (line.truncated) truncatedLines.push(lineNumber)
      return line.output
    })
    .join("\n")
  return { output, truncatedLines }
}

export function diffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue
    if (line.startsWith("+")) additions++
    if (line.startsWith("-")) deletions++
  }
  return { additions, deletions }
}

export function recordSeenSessionLines(sessionID: string, displayPath: string, lines: number[]): void {
  if (lines.length === 0) return
  recordSeenRanges(SessionSeenStore.get(sessionID), displayPath, lines)
}
