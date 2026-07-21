export const SANITIZED_DEFAULT_PROMPT = [{ type: "text", content: "", start: 0, end: 0 }]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback
}

function numberValue(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function cloneRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  return { ...value }
}

function clonePresentation(value: unknown) {
  if (!isRecord(value)) return undefined
  const renderer = value.renderer
  const size = value.size
  return {
    ...(typeof value.hidden === "boolean" ? { hidden: value.hidden } : {}),
    ...(renderer === "image" ||
    renderer === "video" ||
    renderer === "audio" ||
    renderer === "thumbnail" ||
    renderer === "file"
      ? { renderer }
      : {}),
    ...(size === "original" || size === "small" || size === "medium" || size === "large" ? { size } : {}),
    ...(typeof value.crop === "boolean" ? { crop: value.crop } : {}),
  }
}

export function sanitizeContextItemsValue(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  const items: Record<string, unknown>[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    if (item.type !== "file") continue
    const path = stringValue(item.path)
    if (!path) continue
    const selection = isRecord(item.selection) ? item.selection : undefined
    items.push({
      type: "file",
      path,
      selection: selection
        ? {
            startLine: numberValue(selection.startLine),
            startChar: numberValue(selection.startChar),
            endLine: numberValue(selection.endLine),
            endChar: numberValue(selection.endChar),
          }
        : undefined,
    })
  }
  return items
}

export function sanitizePromptContextValue(value: unknown) {
  if (!isRecord(value)) return { items: [] }
  return {
    items: sanitizeContextItemsValue(value.items),
  }
}

function sanitizePromptPart(part: unknown): Record<string, unknown> | undefined {
  if (!isRecord(part)) return undefined
  const type = part.type

  if (type === "text") {
    const content = stringValue(part.content)
    return {
      type,
      content,
      start: numberValue(part.start),
      end: numberValue(part.end, content.length),
    }
  }

  if (type === "file") {
    const path = stringValue(part.path)
    const content = stringValue(part.content, path ? `@${path}` : "")
    if (!path) return undefined
    const selection = isRecord(part.selection) ? part.selection : undefined
    return {
      type,
      path,
      content,
      start: numberValue(part.start),
      end: numberValue(part.end, content.length),
      selection: selection
        ? {
            startLine: numberValue(selection.startLine),
            startChar: numberValue(selection.startChar),
            endLine: numberValue(selection.endLine),
            endChar: numberValue(selection.endChar),
          }
        : undefined,
    }
  }

  if (type === "attachment") {
    const url = stringValue(part.url)
    if (!url || url.startsWith("data:")) return undefined
    const size = part.size
    const metadata = cloneRecord(part.metadata)
    const presentation = clonePresentation(part.presentation)
    return {
      type,
      id: stringValue(part.id),
      filename: stringValue(part.filename, "attachment"),
      mime: stringValue(part.mime, "application/octet-stream"),
      url,
      ...(typeof size === "number" && Number.isFinite(size) ? { size } : {}),
      ...(metadata ? { metadata } : {}),
      ...(presentation ? { presentation } : {}),
    }
  }

  if (type === "note") {
    const noteId = stringValue(part.noteId)
    if (!noteId) return undefined
    return {
      type,
      id: stringValue(part.id),
      noteId,
      title: stringValue(part.title),
      content: stringValue(part.content),
    }
  }

  if (type === "session") {
    const sessionId = stringValue(part.sessionId)
    const directory = stringValue(part.directory)
    if (!sessionId || !directory) return undefined
    const updatedAt = part.updatedAt
    return {
      type,
      id: stringValue(part.id),
      sessionId,
      directory,
      title: stringValue(part.title),
      ...(typeof updatedAt === "number" && Number.isFinite(updatedAt) ? { updatedAt } : {}),
    }
  }

  return undefined
}

export function sanitizePromptValue(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return SANITIZED_DEFAULT_PROMPT.map((part) => ({ ...part }))
  const parts = value.map(sanitizePromptPart).filter((part): part is Record<string, unknown> => !!part)
  return parts.length > 0 ? parts : SANITIZED_DEFAULT_PROMPT.map((part) => ({ ...part }))
}

export function sanitizePromptStateValue(value: unknown) {
  if (!isRecord(value)) return value
  return {
    ...value,
    prompt: sanitizePromptValue(value.prompt),
    context: sanitizePromptContextValue(value.context),
  }
}
