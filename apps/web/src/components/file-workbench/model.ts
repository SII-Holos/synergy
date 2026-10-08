export type FileViewMode = "source" | "preview"
export { ATTACHMENT_PDF_MAX_BYTES as PDF_PREVIEW_MAX_BYTES } from "../resource-preview"
import { ATTACHMENT_PDF_MAX_BYTES as PDF_PREVIEW_MAX_BYTES } from "../resource-preview"

export type PdfPreviewAction = "fetch" | "cached" | "too-large"

export function pdfPreviewAction(input: { nodeSize?: number; hasBytes: boolean; force?: boolean }): PdfPreviewAction {
  if (input.nodeSize !== undefined && input.nodeSize > PDF_PREVIEW_MAX_BYTES) return "too-large"
  if (!input.force && input.hasBytes) return "cached"
  return "fetch"
}

export async function pdfPreviewBytes(data: unknown): Promise<Uint8Array | undefined> {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer())
  return undefined
}

export function normalizeWorkspacePath(input: string) {
  if (!input) return undefined
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(input)) return undefined
  const normalized: string[] = []
  for (const part of input.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "").split("/")) {
    if (!part || part === ".") continue
    if (part === "..") {
      if (normalized.length === 0) return undefined
      normalized.pop()
      continue
    }
    normalized.push(part)
  }
  return normalized.join("/") || undefined
}

function filename(path: string) {
  return path.split("/").at(-1) ?? path
}

export function shortestUniqueFileTitle(path: string, siblings: string[]) {
  const name = filename(path)
  const duplicates = siblings.filter((candidate) => filename(candidate) === name)
  if (duplicates.length < 2) return name

  const parent = path.split("/").slice(0, -1)
  for (let depth = 1; depth <= parent.length; depth += 1) {
    const suffix = parent.slice(-depth).join("/")
    const unique = duplicates.every((candidate) => {
      if (candidate === path) return true
      return candidate.split("/").slice(0, -1).slice(-depth).join("/") !== suffix
    })
    if (unique) return `${name} · ${suffix}`
  }
  return `${name} · ${parent.join("/")}`
}

export function mergeDirectoryPage(existing: string[], incoming: string[], reset: boolean) {
  return Array.from(new Set(reset ? incoming : [...existing, ...incoming]))
}
