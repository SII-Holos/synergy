import type {
  Message,
  SessionPartContent,
  SessionPartPage,
  SessionPartSummary,
} from "@ericsanchezok/synergy-sdk/client"
import type { SessionPartSnapshotAction } from "./session-part-snapshot-freshness"

export type SessionViewportContent = {
  pages: Record<string, SessionPartPage>
  bodies: SessionPartContent[]
}

export async function readSessionViewportContent(input: {
  messages: readonly Message[]
  signal: AbortSignal
  page(messageID: string): Promise<SessionPartPage>
  body(summary: SessionPartSummary): Promise<SessionPartContent>
}): Promise<SessionViewportContent> {
  input.signal.throwIfAborted()
  const root = input.messages.findLast((message) => message.role === "user" && message.isRoot !== false)
  const ids = [...new Set([...(root ? [root.id] : []), ...input.messages.slice(-3).map((message) => message.id)])]
  const responses = await Promise.allSettled(ids.map(input.page))
  input.signal.throwIfAborted()
  const pages: Record<string, SessionPartPage> = {}
  responses.forEach((response, index) => {
    if (response.status === "fulfilled") pages[ids[index]] = response.value
  })
  const wanted: SessionPartSummary[] = []
  let bytes = 0
  for (const id of ids.toReversed()) {
    for (const part of (pages[id]?.items ?? []).toReversed()) {
      if (part.messageID !== id || part.render === false || !["text", "attachment"].includes(part.type)) continue
      if (wanted.length >= 16 || bytes + part.content.bytes > 128 * 1024) continue
      wanted.push(part)
      bytes += part.content.bytes
    }
  }
  const bodies = await Promise.allSettled(wanted.map(input.body))
  input.signal.throwIfAborted()
  return {
    pages,
    bodies: bodies.flatMap((result, index) => {
      const summary = wanted[index]
      if (result.status !== "fulfilled") return []
      const value = result.value
      return value.version === summary.content.version &&
        value.part.id === summary.id &&
        value.part.messageID === summary.messageID &&
        value.part.sessionID === summary.sessionID
        ? [value]
        : []
    }),
  }
}

export function planSessionViewportContent(
  content: SessionViewportContent | undefined,
  action: (messageID: string) => SessionPartSnapshotAction,
): SessionViewportContent | undefined {
  if (!content) return { pages: {}, bodies: [] }
  const pages: SessionViewportContent["pages"] = {}
  for (const [messageID, page] of Object.entries(content.pages)) {
    const current = action(messageID)
    if (current === "retry") return
    if (current === "apply") pages[messageID] = page
  }
  return { pages, bodies: content.bodies.filter((body) => pages[body.part.messageID]) }
}
