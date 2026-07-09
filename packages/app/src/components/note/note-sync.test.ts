import { describe, expect, test } from "bun:test"
import type { BlueprintLoopInfo, NoteInfo, NoteMetaInfo, NoteMetaScopeGroup } from "@ericsanchezok/synergy-sdk/client"
import {
  clearCapturedDirty,
  dirtyConflicts,
  EMPTY_DIRTY_REVISIONS,
  hasDirtyFields,
  noteChangedFields,
  patchBlueprintLoops,
  patchNoteGroups,
  patchNoteGroupsMany,
  shouldReplaceEditorContent,
} from "./note-sync"

function note(input: Partial<NoteInfo> = {}): NoteInfo {
  const now = 1
  return {
    id: input.id ?? "note_1",
    title: input.title ?? "Title",
    content: input.content ?? { type: "doc", content: [] },
    pinned: input.pinned ?? false,
    global: input.global ?? false,
    tags: input.tags ?? [],
    archived: input.archived ?? false,
    version: input.version ?? 1,
    time: input.time ?? { created: now, updated: now },
    kind: input.kind,
    blueprint: input.blueprint,
  }
}

function meta(input: Partial<NoteMetaInfo> = {}): NoteMetaInfo {
  const base = note(input)
  return {
    ...base,
    searchText: input.searchText ?? base.title,
    previewHtml: input.previewHtml,
  }
}

function group(scopeID: string, notes: NoteMetaInfo[]): NoteMetaScopeGroup {
  return { scopeID, scopeType: scopeID === "home" ? "home" : "project", notes }
}

function loop(input: Partial<BlueprintLoopInfo> = {}): BlueprintLoopInfo {
  return {
    id: input.id ?? "loop_1",
    noteID: input.noteID ?? "note_1",
    title: input.title ?? "Loop",
    sessionID: input.sessionID ?? "ses_1",
    auditAgent: input.auditAgent ?? "synergy-max",
    scopeID: input.scopeID ?? "scope_1",
    status: input.status ?? "running",
    runMode: input.runMode,
    source: input.source ?? "user",
    time: input.time ?? { created: 1, updated: 1 },
  }
}

describe("note sync helpers", () => {
  test("detects metadata-only snapshots without replacing equal editor content", () => {
    const before = note()
    const after = note({ pinned: true, version: 2 })

    expect(noteChangedFields(before, after)).toEqual(["pinned"])
    expect(shouldReplaceEditorContent(before.content, after.content)).toBe(false)
  })

  test("detects content changes separately from metadata", () => {
    const before = note()
    const after = note({
      version: 2,
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "changed" }] }] },
    })

    expect(noteChangedFields(before, after)).toEqual(["content"])
    expect(shouldReplaceEditorContent(before.content, after.content)).toBe(true)
  })

  test("keeps dirty fields that changed again during an in-flight save", () => {
    const captured = { ...EMPTY_DIRTY_REVISIONS, content: 1 }
    const current = { ...EMPTY_DIRTY_REVISIONS, content: 2, title: 3 }

    expect(clearCapturedDirty(current, captured)).toEqual({ ...EMPTY_DIRTY_REVISIONS, content: 2, title: 3 })
    expect(hasDirtyFields(clearCapturedDirty(captured, captured))).toBe(false)
  })

  test("conflicts only when remote changes overlap local dirty fields", () => {
    const dirty = { ...EMPTY_DIRTY_REVISIONS, content: 4 }

    expect(dirtyConflicts(dirty, ["blueprint"])).toEqual([])
    expect(dirtyConflicts(dirty, ["content"])).toEqual(["content"])
  })

  test("patches note groups locally and removes stale scope rows", () => {
    const oldNote = meta({ id: "note_1", title: "Old" })
    const newNote = meta({ id: "note_1", title: "New" })
    const groups = [group("scope_1", [oldNote])]

    const patched = patchNoteGroups(groups, {
      scopeID: "home",
      currentScopeID: "scope_1",
      showArchived: false,
      meta: newNote,
    })

    expect(patched).toEqual([group("home", [newNote])])
  })

  test("removes archived notes from active lists and keeps them when archived is visible", () => {
    const archived = meta({ id: "note_1", archived: true })
    const groups = [group("scope_1", [meta({ id: "note_1" })])]

    expect(
      patchNoteGroupsMany(groups, {
        scopeID: "scope_1",
        currentScopeID: "scope_1",
        showArchived: false,
        metas: [archived],
      }),
    ).toEqual([])
    expect(
      patchNoteGroupsMany(groups, {
        scopeID: "scope_1",
        currentScopeID: "scope_1",
        showArchived: true,
        metas: [archived],
      }),
    ).toEqual([group("scope_1", [archived])])
  })

  test("patches BlueprintLoop state without refetching the loop list", () => {
    const existing = loop({ id: "loop_1", status: "running", time: { created: 1, updated: 1 } })
    const updated = loop({ id: "loop_1", status: "completed", time: { created: 1, updated: 2 } })

    expect(patchBlueprintLoops([existing], updated, "scope_1")).toEqual([updated])
    expect(patchBlueprintLoops([updated], loop({ id: "loop_2", scopeID: "other" }), "scope_1")).toEqual([updated])
  })
})
