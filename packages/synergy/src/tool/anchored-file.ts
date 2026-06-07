import * as fs from "fs"
import * as path from "path"
import { FileTime } from "../file/time"
import { Instance } from "../scope/instance"
import { formatHashline, formatHashlineBlock } from "../hashline/format"
import { SessionHashlineStore } from "../hashline/store"
import { normalizeContent } from "../hashline/tag"

export function resolveFilePath(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(Instance.directory, filePath)
}

export function displayPath(filePath: string): string {
  const relative = path.relative(Instance.directory, filePath)
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : filePath
}

export async function assertInsideOrAsk(
  filePath: string,
  ctx: { ask: (input: any) => Promise<void>; extra?: Record<string, unknown> },
) {
  if (ctx.extra?.["bypassCwdCheck"] || Instance.contains(filePath)) return
  const parentDir = path.dirname(filePath)
  await ctx.ask({
    permission: "external_directory",
    patterns: [parentDir],
    metadata: { filepath: filePath, parentDir },
  })
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

export function recordHashlineSnapshot(sessionID: string, filePath: string, content: string): string {
  return SessionHashlineStore.get(sessionID).record(filePath, normalizeContent(content))
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
