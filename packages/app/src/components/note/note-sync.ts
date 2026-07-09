import type { BlueprintLoopInfo, NoteInfo, NoteMetaInfo, NoteMetaScopeGroup } from "@ericsanchezok/synergy-sdk/client"
import { isDeepEqual } from "remeda"

export type NoteChangedField = "title" | "content" | "tags" | "pinned" | "global" | "kind" | "blueprint" | "archived"
export type NoteDirtyField = "title" | "content" | "tags"
export type NoteDirtyRevisions = Record<NoteDirtyField, number>

export const EMPTY_DIRTY_REVISIONS: NoteDirtyRevisions = {
  title: 0,
  content: 0,
  tags: 0,
}

export function deepEqual(a: unknown, b: unknown) {
  return isDeepEqual(a ?? null, b ?? null)
}

export function tagsEqual(a: string[] | undefined, b: string[] | undefined) {
  const left = a ?? []
  const right = b ?? []
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function cloneDirtyRevisions(input: NoteDirtyRevisions): NoteDirtyRevisions {
  return { title: input.title, content: input.content, tags: input.tags }
}

export function hasDirtyFields(input: NoteDirtyRevisions) {
  return input.title > 0 || input.content > 0 || input.tags > 0
}

export function dirtyFieldNames(input: NoteDirtyRevisions): NoteDirtyField[] {
  const fields: NoteDirtyField[] = []
  if (input.title > 0) fields.push("title")
  if (input.content > 0) fields.push("content")
  if (input.tags > 0) fields.push("tags")
  return fields
}

export function clearCapturedDirty(current: NoteDirtyRevisions, captured: NoteDirtyRevisions): NoteDirtyRevisions {
  const next = cloneDirtyRevisions(current)
  for (const field of dirtyFieldNames(captured)) {
    if (next[field] === captured[field]) next[field] = 0
  }
  return next
}

export function noteChangedFields(before: NoteInfo, after: NoteInfo): NoteChangedField[] {
  const changed: NoteChangedField[] = []
  if (before.title !== after.title) changed.push("title")
  if (!deepEqual(before.content, after.content)) changed.push("content")
  if (!tagsEqual(before.tags, after.tags)) changed.push("tags")
  if (before.pinned !== after.pinned) changed.push("pinned")
  if (before.global !== after.global) changed.push("global")
  if (before.kind !== after.kind) changed.push("kind")
  if (!deepEqual(before.blueprint, after.blueprint)) changed.push("blueprint")
  if (before.archived !== after.archived) changed.push("archived")
  return changed
}

export function dirtyConflicts(dirty: NoteDirtyRevisions, changed: NoteChangedField[]): NoteDirtyField[] {
  const changedSet = new Set(changed)
  return dirtyFieldNames(dirty).filter((field) => changedSet.has(field))
}

export function shouldReplaceEditorContent(currentContent: unknown, nextContent: unknown) {
  return !deepEqual(currentContent, nextContent)
}

function sortNotes(notes: NoteMetaInfo[]) {
  notes.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return b.time.updated - a.time.updated
  })
}

function scopeType(scopeID: string): NoteMetaScopeGroup["scopeType"] {
  return scopeID === "home" ? "home" : "project"
}

function isVisibleScope(scopeID: string, currentScopeID: string) {
  return scopeID === "home" || scopeID === currentScopeID
}

export function patchNoteGroups(
  groups: NoteMetaScopeGroup[] | undefined,
  input: {
    scopeID: string
    currentScopeID: string
    showArchived: boolean
    meta?: NoteMetaInfo
    removeID?: string
  },
): NoteMetaScopeGroup[] {
  const noteID = input.removeID ?? input.meta?.id
  if (!noteID) return groups ?? []

  const next = (groups ?? [])
    .map((group) => ({
      ...group,
      notes: group.notes.filter((note) => note.id !== noteID),
    }))
    .filter((group) => group.notes.length > 0)

  if (!input.meta) return next
  if (!isVisibleScope(input.scopeID, input.currentScopeID)) return next
  if (input.meta.archived && !input.showArchived) return next

  let group = next.find((item) => item.scopeID === input.scopeID)
  if (!group) {
    group = { scopeID: input.scopeID, scopeType: scopeType(input.scopeID), notes: [] }
    next.push(group)
  }
  group.notes.push(input.meta)
  sortNotes(group.notes)
  return next
}

export function patchNoteGroupsMany(
  groups: NoteMetaScopeGroup[] | undefined,
  input: {
    scopeID: string
    currentScopeID: string
    showArchived: boolean
    metas: NoteMetaInfo[]
  },
): NoteMetaScopeGroup[] {
  let next = groups ?? []
  for (const meta of input.metas) {
    next = patchNoteGroups(next, { ...input, meta })
  }
  return next
}

export function removeNotesFromGroups(groups: NoteMetaScopeGroup[] | undefined, ids: string[]): NoteMetaScopeGroup[] {
  const remove = new Set(ids)
  return (groups ?? [])
    .map((group) => ({
      ...group,
      notes: group.notes.filter((note) => !remove.has(note.id)),
    }))
    .filter((group) => group.notes.length > 0)
}

export function patchBlueprintLoops(
  loops: BlueprintLoopInfo[] | undefined,
  loop: BlueprintLoopInfo,
  currentScopeID: string,
): BlueprintLoopInfo[] {
  const withoutLoop = (loops ?? []).filter((item) => item.id !== loop.id)
  if (loop.scopeID !== currentScopeID) return withoutLoop
  return [loop, ...withoutLoop].sort((a, b) => b.time.updated - a.time.updated)
}
