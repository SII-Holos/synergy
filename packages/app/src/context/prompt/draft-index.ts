import { createSignal } from "solid-js"
import { forEachWorkspaceSessionEntry, parseWorkspaceSessionEntryKey } from "@/utils/persist"
import { sanitizePromptValue } from "./sanitize"
import { DEFAULT_PROMPT, isPromptEqual } from "./equality"
import type { Prompt } from "./index"

const [draftSessions, setDraftSessions] = createSignal<ReadonlySet<string>>(new Set(), { equals: false })

function isStoredDraft(value: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return false
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false
  const prompt = sanitizePromptValue((parsed as { prompt?: unknown }).prompt) as unknown as Prompt
  return !isPromptEqual(prompt, DEFAULT_PROMPT)
}

export function rebuildDraftSessionIndex() {
  const next = new Set<string>()
  forEachWorkspaceSessionEntry("prompt", (session, value) => {
    if (isStoredDraft(value)) next.add(session)
  })
  setDraftSessions(next)
}

export function markDraftSession(session: string | undefined, dirty: boolean) {
  if (!session) return
  const current = new Set(draftSessions())
  const had = current.delete(session)
  if (dirty) current.add(session)
  if (dirty === had) return
  setDraftSessions(current)
}

export function hasDraftSession(session: string): boolean {
  return draftSessions().has(session)
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === null) {
      rebuildDraftSessionIndex()
      return
    }
    const session = parseWorkspaceSessionEntryKey(event.key, "prompt")
    if (!session) return
    markDraftSession(session, event.newValue !== null && isStoredDraft(event.newValue))
  })
  rebuildDraftSessionIndex()
}
