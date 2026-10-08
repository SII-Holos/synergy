import { AssetReference } from "@ericsanchezok/synergy-util/asset-reference"
import { ResourceReference } from "@ericsanchezok/synergy-util/resource-reference"
import type { ResourcePreviewKind } from "../resource-preview"
export { ATTACHMENT_TEXT_MAX_BYTES, ATTACHMENT_PDF_MAX_BYTES } from "../resource-preview"
import type { AttachmentPart, Part, ToolPart } from "@ericsanchezok/synergy-sdk"

export interface AttachmentLocator {
  version: 1
  sessionID: string
  messageID: string
  attachmentID: string
}

export type AttachmentResourceState = (AttachmentLocator | { version: 1; url: string; filename?: string }) & {
  referenceContext?: ResourceReference.Context
  location?: ResourceReference.Location
  navigation?: number
}

export interface AttachmentWorkbenchPanelInit {
  resourceId: string
  title?: string
  source: "conversation"
  state: AttachmentResourceState
}

export class AttachmentTooLargeError extends Error {
  constructor(
    readonly limit: number,
    readonly actual?: number,
  ) {
    super("Attachment exceeds the preview size limit")
    this.name = "AttachmentTooLargeError"
  }
}

export function attachmentResourceState(value: unknown): AttachmentResourceState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const state = value as Record<string, unknown>
  if (state.version !== 1) return undefined
  const navigation = {
    referenceContext: ResourceReference.Context.safeParse(state.referenceContext).data,
    location: ResourceReference.Location.safeParse(state.location).data,
    navigation: typeof state.navigation === "number" ? state.navigation : undefined,
  }
  if (typeof state.url === "string" && AssetReference.parse(state.url))
    return {
      version: 1,
      url: state.url,
      filename: typeof state.filename === "string" ? state.filename : undefined,
      ...navigation,
    }
  if (typeof state.sessionID !== "string" || !state.sessionID) return undefined
  if (typeof state.messageID !== "string" || !state.messageID) return undefined
  if (typeof state.attachmentID !== "string" || !state.attachmentID) return undefined
  return {
    version: 1,
    sessionID: state.sessionID,
    messageID: state.messageID,
    attachmentID: state.attachmentID,
    ...navigation,
  }
}

export function attachmentResourceId(state: AttachmentResourceState): string {
  if ("url" in state) return state.url
  return [state.sessionID, state.messageID, state.attachmentID].map(encodeURIComponent).join("/")
}

export function attachmentWorkbenchPanelInit(attachment: {
  id?: string
  sessionID?: string
  messageID?: string
  filename?: string
  url?: string
}): AttachmentWorkbenchPanelInit | undefined {
  if (!attachment.id || !attachment.sessionID || !attachment.messageID) {
    if (!attachment.url || !AssetReference.parse(attachment.url)) return undefined
    const state: AttachmentResourceState = { version: 1, url: attachment.url, filename: attachment.filename }
    return { resourceId: attachmentResourceId(state), title: attachment.filename, source: "conversation", state }
  }
  const state: AttachmentResourceState = {
    version: 1,
    sessionID: attachment.sessionID,
    messageID: attachment.messageID,
    attachmentID: attachment.id,
  }
  return {
    resourceId: attachmentResourceId(state),
    title: attachment.filename,
    source: "conversation",
    state,
  }
}

function completedToolAttachments(part: Part): AttachmentPart[] {
  if (part.type !== "tool") return []
  const state = (part as ToolPart).state
  return state.status === "completed" ? (state.attachments ?? []) : []
}

export function findAttachmentByLocator(
  parts: Part[] | undefined,
  locator: AttachmentLocator,
): AttachmentPart | undefined {
  for (const part of parts ?? []) {
    if (part.type === "attachment" && part.id === locator.attachmentID) return part
    const nested = completedToolAttachments(part).find((attachment) => attachment.id === locator.attachmentID)
    if (nested) return nested
  }
  return undefined
}

function extension(filename: string | undefined) {
  return filename?.split(".").at(-1)?.toLowerCase()
}

export async function fetchAttachmentBytes(
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  url: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted()
  const response = await fetcher(url, { signal })
  signal?.throwIfAborted()
  if (!response.ok) throw new Error(`Attachment request failed (${response.status})`)
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maxBytes) throw new AttachmentTooLargeError(maxBytes, declared)

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    signal?.throwIfAborted()
    if (bytes.byteLength > maxBytes) throw new AttachmentTooLargeError(maxBytes, bytes.byteLength)
    return bytes
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const chunk = await reader.read()
      signal?.throwIfAborted()
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new AttachmentTooLargeError(maxBytes, total)
      }
      chunks.push(chunk.value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export function createAttachmentPreviewReader(
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  let active: AbortController | undefined

  return {
    async read(url: string, maxBytes: number) {
      active?.abort()
      const controller = new AbortController()
      active = controller
      try {
        return await fetchAttachmentBytes(fetcher, url, maxBytes, controller.signal)
      } finally {
        if (active === controller) active = undefined
      }
    },
    cancel() {
      active?.abort()
      active = undefined
    },
  }
}

export function attachmentOpenInBrowserUrl(
  kind: ResourcePreviewKind | undefined,
  url: string | undefined,
): string | undefined {
  return kind === "html" && url ? url : undefined
}

export function attachmentSourceMarkdown(text: string, filename?: string): string {
  const languages: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    py: "python",
    rs: "rust",
    sh: "bash",
    yml: "yaml",
    md: "markdown",
    svg: "xml",
    json: "json",
    html: "html",
    css: "css",
    xml: "xml",
    yaml: "yaml",
    go: "go",
  }
  let longest = 0,
    run = 0
  for (const character of text) {
    run = character === "~" ? run + 1 : 0
    longest = Math.max(longest, run)
  }
  const fence = "~".repeat(Math.max(3, longest + 1))
  return `${fence}${languages[extension(filename) ?? ""] ?? ""}\n${text}\n${fence}`
}
