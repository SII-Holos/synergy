export type FileViewMode = "source" | "preview"
export type FilePreviewKind = "source" | "markdown" | "svg" | "image" | "pdf" | "unsupported"

export type FilePreviewCapability = {
  kind: FilePreviewKind
  defaultMode: FileViewMode
  dual: boolean
}

export const PDF_PREVIEW_MAX_BYTES = 50 * 1024 * 1024

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

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"])

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

export function classifyFilePreview(
  path: string,
  resultKind: "text" | "image" | "binary",
  mimeType?: string,
): FilePreviewCapability {
  const extension = filename(path).split(".").at(-1)?.toLowerCase() ?? ""
  if (resultKind === "image" || IMAGE_EXTENSIONS.has(extension)) {
    return { kind: "image", defaultMode: "preview", dual: false }
  }
  if (resultKind === "binary") {
    if (extension === "pdf" || mimeType === "application/pdf") {
      return { kind: "pdf", defaultMode: "preview", dual: false }
    }
    return { kind: "unsupported", defaultMode: "preview", dual: false }
  }
  if (extension === "md" || extension === "markdown") {
    return { kind: "markdown", defaultMode: "preview", dual: true }
  }
  if (extension === "svg") return { kind: "svg", defaultMode: "preview", dual: true }
  return { kind: "source", defaultMode: "source", dual: false }
}

export function mergeDirectoryPage(existing: string[], incoming: string[], reset: boolean) {
  return Array.from(new Set(reset ? incoming : [...existing, ...incoming]))
}

export function resolveWorkspaceRelativePath(fromFile: string, target: string) {
  if (!target || target.startsWith("#")) return undefined
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith("//")) return undefined
  let decoded: string
  try {
    decoded = decodeURIComponent(target.split(/[?#]/, 1)[0] ?? "")
  } catch {
    return undefined
  }
  const parent = fromFile.split("/").slice(0, -1).join("/")
  return normalizeWorkspacePath(parent ? `${parent}/${decoded}` : decoded)
}
