const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/html": "html",
  "text/css": "css",
  "text/csv": "csv",
  "text/xml": "xml",
  "text/yaml": "yaml",
  "text/x-python": "py",
  "text/x-shellscript": "sh",
  "application/json": "json",
  "application/xml": "xml",
  "application/javascript": "js",
  "application/typescript": "ts",
  "application/x-yaml": "yaml",
}

const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  pdf: "application/pdf",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
  css: "text/css",
  csv: "text/csv",
  xml: "text/xml",
  yaml: "text/yaml",
  yml: "text/yaml",
  py: "text/x-python",
  sh: "text/x-shellscript",
  json: "application/json",
  js: "application/javascript",
  ts: "application/typescript",
}

export namespace AssetReference {
  export function isValidId(id: string): boolean {
    return /^[a-f0-9]{16}(\.[a-z0-9]+)?$/.test(id) && id.trim() === id
  }

  export function parse(value: string) {
    if (!value.startsWith("asset://")) return undefined
    const id = value.slice(8)
    if (!isValidId(id)) return undefined
    return { id, url: value, mime: mimeFromExt(extFromId(id)) }
  }

  export function mimeFromExt(ext: string): string {
    return EXT_TO_MIME[ext] ?? "application/octet-stream"
  }

  export function extFromMime(mime: string): string | undefined {
    return MIME_TO_EXT[mime]
  }

  /** Filename-derived extension normalized to the asset-ID alphabet; anything
   *  outside [a-z0-9] (e.g. "x86_64") falls back to undefined so the caller's
   *  `.bin` default keeps generated IDs valid for `isValidId()`. */
  export function extFromName(name: string): string | undefined {
    const dot = name.lastIndexOf(".")
    const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : undefined
    return ext && /^[a-z0-9]+$/.test(ext) ? ext : undefined
  }

  export function extFromId(id: string): string {
    const dot = id.lastIndexOf(".")
    return dot >= 0 ? id.slice(dot + 1) : "bin"
  }
}
