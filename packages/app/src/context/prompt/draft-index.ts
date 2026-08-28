import { createSignal } from "solid-js"
import { forEachWorkspaceSessionEntry, parseWorkspaceSessionEntryKey } from "../../utils/persist"
import { sanitizePromptValue } from "./sanitize"
import { DEFAULT_PROMPT, isPromptEqual } from "./equality"
import type { Prompt } from "./index"

// Stored marks mirror persisted prompt entries; local marks mirror the dirty
// state of composer sessions mounted in this tab. The badge is their union so
// a cross-tab clear cannot erase the fact that the composer the user is typing
// into still holds unsent input, while a submit in this tab clears both.
const [storedDrafts, setStoredDrafts] = createSignal<ReadonlySet<string>>(new Set())
const [localDrafts, setLocalDrafts] = createSignal<ReadonlySet<string>>(new Set())

function withMark(current: ReadonlySet<string>, session: string, marked: boolean): ReadonlySet<string> {
  if (current.has(session) === marked) return current
  const next = new Set(current)
  if (marked) next.add(session)
  else next.delete(session)
  return next
}

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
  setStoredDrafts(next)
}

export function markDraftSession(session: string | undefined, dirty: boolean) {
  if (!session) return
  setLocalDrafts((current) => withMark(current, session, dirty))
  setStoredDrafts((current) => withMark(current, session, dirty))
}

export function clearLocalDraftMark(session: string | undefined) {
  if (!session) return
  setLocalDrafts((current) => withMark(current, session, false))
}

export function forgetDraftSession(session: string) {
  clearLocalDraftMark(session)
  setStoredDrafts((current) => withMark(current, session, false))
}

export function hasDraftSession(session: string): boolean {
  return storedDrafts().has(session) || localDrafts().has(session)
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === null) {
      rebuildDraftSessionIndex()
      return
    }
    const session = parseWorkspaceSessionEntryKey(event.key, "prompt")
    if (!session) return
    setStoredDrafts((current) => withMark(current, session, event.newValue !== null && isStoredDraft(event.newValue)))
  })
  rebuildDraftSessionIndex()
}
