import { createSignal } from "solid-js"
import { forEachWorkspaceSessionEntry, parseWorkspaceSessionEntryKey, workspaceEntryOwner } from "../../utils/persist"
import { sanitizePromptValue } from "./sanitize"
import { DEFAULT_PROMPT, isPromptEqual } from "./equality"
import type { Prompt } from "."

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

export function createDraftSessionIndex(connection: string) {
  const [storedDrafts, setStoredDrafts] = createSignal<ReadonlySet<string>>(new Set())
  const [localDrafts, setLocalDrafts] = createSignal<ReadonlySet<string>>(new Set())
  const owns = (key: string | undefined) => {
    if (!key) return false
    try {
      const owner: unknown = JSON.parse(key)
      return Array.isArray(owner) && owner.length === 2 && owner[0] === connection
    } catch {
      return false
    }
  }
  function rebuildDraftSessionIndex() {
    const next = new Set<string>()
    forEachWorkspaceSessionEntry("prompt", (session, value, owner) => {
      if (owns(owner) && isStoredDraft(value)) next.add(session)
    })
    setStoredDrafts(next)
  }

  function markDraftSession(session: string | undefined, dirty: boolean) {
    if (!session) return
    setLocalDrafts((current) => withMark(current, session, dirty))
    setStoredDrafts((current) => withMark(current, session, dirty))
  }

  function clearLocalDraftMark(session: string | undefined) {
    if (!session) return
    setLocalDrafts((current) => withMark(current, session, false))
  }

  function forgetDraftSession(session: string) {
    clearLocalDraftMark(session)
    setStoredDrafts((current) => withMark(current, session, false))
  }

  function hasDraftSession(session: string): boolean {
    return storedDrafts().has(session) || localDrafts().has(session)
  }

  const onStorage = (event: StorageEvent) => {
    if (event.key === null) {
      rebuildDraftSessionIndex()
      return
    }
    if (!owns(workspaceEntryOwner(event.key))) return
    const session = parseWorkspaceSessionEntryKey(event.key, "prompt")
    if (!session) return
    setStoredDrafts((current) => withMark(current, session, event.newValue !== null && isStoredDraft(event.newValue)))
  }
  window.addEventListener("storage", onStorage)
  rebuildDraftSessionIndex()
  return {
    rebuildDraftSessionIndex,
    markDraftSession,
    clearLocalDraftMark,
    forgetDraftSession,
    hasDraftSession,
    dispose() {
      window.removeEventListener("storage", onStorage)
    },
  }
}
