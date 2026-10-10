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
  // Seed part structure for the whole initial window so the first rendered
  // frame is complete in one batched fan-out. The endpoint caps at 100 IDs
  // per request; anything older falls back to the row-driven lazy path.
  const ids = [...new Set(input.messages.map((message) => message.id))].slice(-100)
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

/**
 * Replay a message's already-materialized first-page summaries as the
 * endpoint's page shape. Only usable when the window is complete
 * (`page.hasEarlier === false`): a partial window must keep flowing through
 * the batch endpoint so cursor state stays faithful.
 */
export function cachedPartPageSnapshot(
  items: readonly SessionPartSummary[] | undefined,
  page: { hasEarlier: boolean } | undefined,
): SessionPartPage | undefined {
  if (!items?.length || page?.hasEarlier !== false) return undefined
  return {
    items: [...items].sort((a, b) => a.id.localeCompare(b.id)),
    nextCursor: null,
    previousCursor: null,
    hasMore: false,
    hasEarlier: false,
  }
}
