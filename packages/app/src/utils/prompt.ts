import type { AttachmentPart, Part, TextPart } from "@ericsanchezok/synergy-sdk"
import { sanitizeContextItemsValue, sanitizePromptContextValue, sanitizePromptValue } from "@/context/prompt-sanitize"

type FileSelection = {
  startLine: number
  startChar: number
  endLine: number
  endChar: number
}

type TextPromptPart = {
  type: "text"
  content: string
  start: number
  end: number
}

type FileAttachmentPart = {
  type: "file"
  path: string
  content: string
  start: number
  end: number
  selection?: FileSelection
}

type UploadedAttachmentPart = {
  type: "attachment"
  id: string
  filename: string
  mime: string
  url: string
  metadata?: Record<string, unknown>
  presentation?: {
    hidden?: boolean
    renderer?: "image" | "video" | "audio" | "thumbnail" | "file"
    size?: "original" | "small" | "medium" | "large"
    crop?: boolean
  }
}

type NoteAttachmentPart = {
  type: "note"
  id: string
  noteId: string
  title: string
  content: string
}

type SessionAttachmentPart = {
  type: "session"
  id: string
  sessionId: string
  directory: string
  title: string
  updatedAt?: number
}

type Prompt = Array<
  TextPromptPart | FileAttachmentPart | UploadedAttachmentPart | NoteAttachmentPart | SessionAttachmentPart
>

type ContextItem = {
  type: "file"
  path: string
  selection?: FileSelection
}

type PromptContextSnapshot = {
  activeTab: boolean
  items: ContextItem[]
}

function keyForContextItem(item: ContextItem) {
  const startLine = item.selection?.startLine
  const startChar = item.selection?.startChar
  const endLine = item.selection?.endLine
  const endChar = item.selection?.endChar
  return `${item.type}:${item.path}:${startLine}:${startChar}:${endLine}:${endChar}`
}

function sanitizeContextItems(value: unknown): ContextItem[] {
  const items = sanitizeContextItemsValue(value) as unknown as ContextItem[]
  const seen = new Set<string>()
  const result: ContextItem[] = []
  for (const item of items) {
    const key = keyForContextItem(item)
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ ...item, selection: item.selection ? { ...item.selection } : undefined })
  }
  return result
}

function sanitizePrompt(value: unknown): Prompt {
  return sanitizePromptValue(value) as unknown as Prompt
}

function sanitizePromptContext(value: unknown): PromptContextSnapshot {
  const context = sanitizePromptContextValue(value)
  return {
    activeTab: context.activeTab,
    items: sanitizeContextItems(context.items),
  }
}

type Inline = {
  type: "file"
  start: number
  end: number
  value: string
  path: string
  selection?: {
    startLine: number
    endLine: number
    startChar: number
    endChar: number
  }
}

export type PromptDraftSnapshot = {
  version: 1
  prompt: Prompt
  context: PromptContextSnapshot
}

export type PromptDraftMetadataMessage = {
  id?: string
  parts?: Part[]
  metadata?: Record<string, unknown>
}

/**
 * Extract text content from parts filtered by origin for rewind backfill.
 * When rewinding, the draft text from the cut message should be extracted
 * to restore the user's original input.
 */
export function extractPromptTextForRewind(input: { message?: PromptDraftMetadataMessage; parts: Part[] }): string {
  const promptDraft = input.message?.metadata?.promptDraft
  if (isRecord(promptDraft) && promptDraft.version === 1) {
    const prompt = sanitizePromptValue(promptDraft.prompt) as unknown as Prompt
    return prompt
      .map((part) => {
        if (part.type === "text") return part.content
        if (part.type === "file") return part.content
        if (part.type === "attachment") return ""
        if (part.type === "note") return part.content
        if (part.type === "session") return ""
        return ""
      })
      .join("")
      .trim()
  }

  // Fallback: extract by part.origin from the cut message
  const textPart = textPartValue(input.parts)
  if (textPart) {
    // Prefer non-system origin text
    const nonSystemTexts = input.parts
      .filter((part): part is TextPart => part.type === "text")
      .filter((part) => part.origin !== "system" && !part.synthetic && !part.ignored)
    if (nonSystemTexts.length > 0) {
      return nonSystemTexts
        .map((part) => part.text)
        .join("\n")
        .trim()
    }
    return textPart.text.trim()
  }
  return ""
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function cloneDraft(snapshot: PromptDraftSnapshot): PromptDraftSnapshot {
  return {
    version: 1,
    prompt: sanitizePrompt(snapshot.prompt),
    context: sanitizePromptContext(snapshot.context),
  }
}

function selectionFromFileUrl(url: string): Inline["selection"] {
  const queryIndex = url.indexOf("?")
  if (queryIndex === -1) return undefined
  const params = new URLSearchParams(url.slice(queryIndex + 1))
  const startLine = Number(params.get("start"))
  const endLine = Number(params.get("end"))
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return undefined
  return {
    startLine,
    endLine,
    startChar: 0,
    endChar: 0,
  }
}

function filePathFromUrl(url: string) {
  if (!url.startsWith("file://")) return undefined
  const queryIndex = url.indexOf("?")
  const withoutQuery = queryIndex === -1 ? url : url.slice(0, queryIndex)
  try {
    const path = decodeURIComponent(withoutQuery.slice("file://".length))
    if (!path) return undefined
    if (/^\/[A-Za-z]:/.test(path)) return path.slice(1)
    return path
  } catch {
    return undefined
  }
}

function textPartValue(parts: Part[]) {
  const candidates = parts
    .filter((part): part is TextPart => part.type === "text")
    .filter((part) => (part.origin !== undefined ? part.origin !== "system" : !part.synthetic && !part.ignored))
  return candidates.reduce((best: TextPart | undefined, part) => {
    if (!best) return part
    if (part.text.length > best.text.length) return part
    return best
  }, undefined)
}

function createRelativePathResolver(directory?: string) {
  return (path: string) => {
    if (!directory) return path

    const normalizedDirectory = directory.replace(/\\/g, "/")
    const normalizedPath = path.replace(/\\/g, "/")
    const prefix = normalizedDirectory.endsWith("/") ? normalizedDirectory : normalizedDirectory + "/"
    if (normalizedPath.startsWith(prefix)) return normalizedPath.slice(prefix.length)

    if (normalizedPath.startsWith(normalizedDirectory)) {
      const next = normalizedPath.slice(normalizedDirectory.length)
      if (next.startsWith("/")) return next.slice(1)
    }

    return path
  }
}

function restoreLegacyPromptDraft(parts: Part[], opts?: { directory?: string }): PromptDraftSnapshot {
  const textPart = textPartValue(parts)
  const text = textPart?.text ?? ""
  const toRelative = createRelativePathResolver(opts?.directory)

  const inline: Inline[] = []
  const attachments: UploadedAttachmentPart[] = []
  const sessionAttachments: SessionAttachmentPart[] = []
  const contextItems: ContextItem[] = []
  const seenContext = new Set<string>()

  const addContextItem = (item: ContextItem) => {
    const sanitized = sanitizeContextItems([item])[0]
    if (!sanitized) return
    const key = keyForContextItem(sanitized)
    if (seenContext.has(key)) return
    seenContext.add(key)
    contextItems.push(sanitized)
  }

  for (const part of parts) {
    if (part.type !== "attachment") continue
    const filePart = part as AttachmentPart
    const sourceText = filePart.source?.text
    if (sourceText) {
      const value = sourceText.value
      const start = sourceText.start
      const end = sourceText.end
      let path = value
      if (value.startsWith("@")) path = value.slice(1)
      if (!value.startsWith("@") && filePart.source && "path" in filePart.source) {
        path = filePart.source.path
      }
      inline.push({
        type: "file",
        start,
        end,
        value,
        path: toRelative(path),
        selection: selectionFromFileUrl(filePart.url),
      })
      continue
    }

    if (filePart.url.startsWith("file://")) {
      const path = filePathFromUrl(filePart.url)
      if (path) addContextItem({ type: "file", path: toRelative(path), selection: selectionFromFileUrl(filePart.url) })
      continue
    }

    if (
      filePart.url.startsWith("http://") ||
      filePart.url.startsWith("https://") ||
      filePart.url.startsWith("asset://")
    ) {
      attachments.push({
        type: "attachment",
        id: filePart.id,
        filename: filePart.filename ?? "attachment",
        mime: filePart.mime,
        url: filePart.url,
        metadata: filePart.metadata,
        presentation: filePart.presentation,
      })
      continue
    }

    if (filePart.metadata?.kind === "session") {
      const metadata = filePart.metadata
      if (typeof metadata.sessionId === "string" && typeof metadata.directory === "string") {
        sessionAttachments.push({
          type: "session",
          id: filePart.id,
          sessionId: metadata.sessionId,
          directory: metadata.directory,
          title: typeof metadata.title === "string" ? metadata.title : (filePart.filename ?? "Untitled"),
          updatedAt: typeof metadata.updatedAt === "number" ? metadata.updatedAt : undefined,
        })
      }
    }
  }

  inline.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start
    return a.end - b.end
  })

  const prompt: Prompt = []
  let position = 0
  let cursor = 0

  const pushText = (content: string) => {
    if (!content) return
    prompt.push({
      type: "text",
      content,
      start: position,
      end: position + content.length,
    })
    position += content.length
  }

  const pushFile = (item: Inline) => {
    const content = item.value
    const attachment: FileAttachmentPart = {
      type: "file",
      path: item.path,
      content,
      start: position,
      end: position + content.length,
      selection: item.selection,
    }
    prompt.push(attachment)
    position += content.length
  }

  for (const item of inline) {
    if (item.start < 0 || item.end < item.start) continue

    const expected = item.value
    if (!expected) continue

    const mismatch = item.end > text.length || item.start < cursor || text.slice(item.start, item.end) !== expected
    const start = mismatch ? text.indexOf(expected, cursor) : item.start
    if (start === -1) continue
    const end = mismatch ? start + expected.length : item.end

    pushText(text.slice(cursor, start))
    pushFile(item)
    cursor = end
  }

  pushText(text.slice(cursor))

  if (prompt.length === 0) {
    prompt.push({ type: "text", content: "", start: 0, end: 0 })
  }

  return {
    version: 1,
    prompt: sanitizePrompt([...prompt, ...attachments, ...sessionAttachments]),
    context: {
      activeTab: contextItems.length === 0,
      items: contextItems,
    },
  }
}

export function createPromptDraftSnapshot(input: {
  prompt: Prompt
  context: PromptContextSnapshot
  activeFile?: string
}): PromptDraftSnapshot {
  const prompt = sanitizePrompt(input.prompt)
  const contextItems = [...sanitizeContextItems(input.context.items)]
  const activeFile = input.activeFile
  const activeFileMaterialized = input.context.activeTab && !!activeFile
  if (activeFileMaterialized) contextItems.push({ type: "file", path: activeFile })

  return {
    version: 1,
    prompt,
    context: {
      activeTab: activeFileMaterialized ? false : input.context.activeTab,
      items: sanitizeContextItems(contextItems),
    },
  }
}

export function createSubmitFailureRestoreSnapshot(input: {
  prompt: Prompt
  context: PromptContextSnapshot
}): PromptDraftSnapshot {
  return createPromptDraftSnapshot(input)
}

export function extractPromptDraft(input: {
  message?: PromptDraftMetadataMessage
  parts: Part[]
  directory?: string
}): PromptDraftSnapshot {
  const promptDraft = input.message?.metadata?.promptDraft
  if (isRecord(promptDraft) && promptDraft.version === 1) {
    return cloneDraft({
      version: 1,
      prompt: promptDraft.prompt as Prompt,
      context: promptDraft.context as PromptContextSnapshot,
    })
  }

  return restoreLegacyPromptDraft(input.parts, { directory: input.directory })
}
