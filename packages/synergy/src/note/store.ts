import { Storage } from "../storage/storage"
import z from "zod"
import { StoragePath } from "../storage/path"
import { Identifier } from "../id/id"
import { ScopeContext } from "../scope/context"
import { Bus } from "../bus"
import { NoteEvent } from "./event"
import { NoteTypes } from "./types"
import { NoteError } from "./error"
import { Log } from "../util/log"
import { Plugin } from "../plugin"
import { NoteMarkdown } from "./markdown"
import { NoteDocument } from "./document"
import { isDeepEqual } from "remeda"

export namespace NoteStore {
  const log = Log.create({ service: "note.store" })
  const HOME_SCOPE_ID = "home"

  export type Metadata = z.infer<typeof NoteTypes.MetaInfo>

  function normalizeBlueprint(note: z.infer<typeof NoteTypes.Info>): void {
    if (note.kind !== "blueprint") {
      note.blueprint = undefined
      return
    }

    const blueprint = note.blueprint as (z.infer<typeof NoteTypes.Info>["blueprint"] & { status?: unknown }) | undefined
    if (!blueprint) {
      note.blueprint = {}
      return
    }
    delete blueprint.status
    note.blueprint = blueprint
  }

  function normalize(note: z.infer<typeof NoteTypes.Info>): z.infer<typeof NoteTypes.Info> {
    note.global ??= false
    note.archived ??= false
    note.version ??= 1
    note.kind ??= "note"
    note.content = NoteDocument.normalize(note.content)
    normalizeBlueprint(note)
    return note
  }

  function toMetadata(note: z.infer<typeof NoteTypes.Info>): Metadata {
    const { content, ...meta } = note
    const markdown = NoteMarkdown.toMarkdown(content)
    const searchParts = [note.title, ...(note.tags ?? []), markdown].filter(Boolean)
    const previewHtml = NoteMarkdown.toPreviewHtml(content, { title: note.title }) || undefined
    return { ...meta, searchText: searchParts.join("\n"), previewHtml }
  }

  function arrayEqual(a: string[] | undefined, b: string[] | undefined): boolean {
    const left = a ?? []
    const right = b ?? []
    return left.length === right.length && left.every((value, index) => value === right[index])
  }

  function deepEqual(a: unknown, b: unknown): boolean {
    return isDeepEqual(a ?? null, b ?? null)
  }

  function changedFields(
    before: z.infer<typeof NoteTypes.Info>,
    after: z.infer<typeof NoteTypes.Info>,
  ): NoteTypes.ChangedField[] {
    const changed: NoteTypes.ChangedField[] = []
    if (before.title !== after.title) changed.push("title")
    if (NoteDocument.hash(before.content) !== NoteDocument.hash(after.content)) changed.push("content")
    if (!arrayEqual(before.tags, after.tags)) changed.push("tags")
    if (before.pinned !== after.pinned) changed.push("pinned")
    if (before.global !== after.global) changed.push("global")
    if (before.kind !== after.kind) changed.push("kind")
    if (!deepEqual(before.blueprint, after.blueprint)) changed.push("blueprint")
    if (before.archived !== after.archived) changed.push("archived")
    return changed
  }

  function comparePinTime(a: { pinned: boolean; time: { updated: number } }, b: typeof a): number {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return b.time.updated - a.time.updated
  }

  function sortByPinAndTime<T extends { pinned: boolean; time: { updated: number } }>(items: T[]): void {
    items.sort(comparePinTime)
  }

  function mergeSorted<T>(a: T[], b: T[], compare: (x: T, y: T) => number): T[] {
    const result: T[] = []
    let i = 0
    let j = 0
    while (i < a.length && j < b.length) {
      result.push(compare(a[i], b[j]) <= 0 ? a[i++] : b[j++])
    }
    while (i < a.length) result.push(a[i++])
    while (j < b.length) result.push(b[j++])
    return result
  }

  // --- Archive status filter ---
  export type ArchiveFilter = "active" | "archived" | "all"
  export function filterArchive<T extends { archived?: boolean }>(items: T[], filter: ArchiveFilter): T[] {
    if (filter === "active") return items.filter((i) => !i.archived)
    if (filter === "archived") return items.filter((i) => i.archived)
    return items
  }

  // --- Index management ---

  const INDEX_ID = "_index"

  function indexPath(sid: Identifier.ScopeID) {
    return StoragePath.note(sid, INDEX_ID)
  }

  async function loadIndex(scopeID: string): Promise<Metadata[]> {
    const sid = Identifier.asScopeID(scopeID)
    try {
      return await Storage.read<Metadata[]>(indexPath(sid))
    } catch {
      return rebuildIndex(scopeID)
    }
  }

  async function rebuildIndex(scopeID: string): Promise<Metadata[]> {
    const sid = Identifier.asScopeID(scopeID)
    const ids = (await Storage.scan(StoragePath.notesRoot(sid))).filter((id) => !id.startsWith("_"))
    if (ids.length === 0) return []
    const keys = ids.map((id) => StoragePath.note(sid, id))
    const results = await Storage.readMany<z.infer<typeof NoteTypes.Info>>(keys)
    const entries = results
      .filter((n): n is z.infer<typeof NoteTypes.Info> => n !== undefined)
      .map((n) => toMetadata(normalize(n)))
    sortByPinAndTime(entries)
    await Storage.write(indexPath(sid), entries)
    log.info("index rebuilt", { scopeID, count: entries.length })
    return entries
  }

  async function indexSet(scopeID: string, note: z.infer<typeof NoteTypes.Info>): Promise<void> {
    const entries = await loadIndex(scopeID)
    const entry = toMetadata(note)
    const idx = entries.findIndex((e) => e.id === note.id)
    if (idx >= 0) entries[idx] = entry
    else entries.push(entry)
    sortByPinAndTime(entries)
    await Storage.write(indexPath(Identifier.asScopeID(scopeID)), entries)
  }

  async function indexUpdateMany(scopeID: string, notes: z.infer<typeof NoteTypes.Info>[]): Promise<void> {
    const entries = await loadIndex(scopeID)
    for (const note of notes) {
      const entry = toMetadata(note)
      const idx = entries.findIndex((e) => e.id === note.id)
      if (idx >= 0) entries[idx] = entry
      else entries.push(entry)
    }
    sortByPinAndTime(entries)
    await Storage.write(indexPath(Identifier.asScopeID(scopeID)), entries)
  }

  async function indexRemove(scopeID: string, noteID: string): Promise<void> {
    const entries = await loadIndex(scopeID)
    const filtered = entries.filter((e) => e.id !== noteID)
    await Storage.write(indexPath(Identifier.asScopeID(scopeID)), filtered)
  }

  // --- Scope resolution ---

  async function resolveScope(
    scopeID: string,
    noteID: string,
  ): Promise<{ scopeID: string; note: z.infer<typeof NoteTypes.Info> }> {
    const sid = Identifier.asScopeID(scopeID)
    try {
      const note = await Storage.read<z.infer<typeof NoteTypes.Info>>(StoragePath.note(sid, noteID))
      return { scopeID, note: normalize(note) }
    } catch {
      // fallthrough
    }
    if (scopeID !== HOME_SCOPE_ID) {
      const globalSid = Identifier.asScopeID(HOME_SCOPE_ID)
      try {
        const note = await Storage.read<z.infer<typeof NoteTypes.Info>>(StoragePath.note(globalSid, noteID))
        return { scopeID: HOME_SCOPE_ID, note: normalize(note) }
      } catch {
        // fallthrough
      }
    }
    const scopeIDs = await Storage.scan(["notes"])
    for (const candidate of scopeIDs) {
      if (candidate === scopeID || candidate === HOME_SCOPE_ID) continue
      try {
        const note = await Storage.read<z.infer<typeof NoteTypes.Info>>(
          StoragePath.note(Identifier.asScopeID(candidate), noteID),
        )
        return { scopeID: candidate, note: normalize(note) }
      } catch {
        // continue
      }
    }
    throw new Storage.NotFoundError({ message: `Note not found: ${noteID}` })
  }

  // --- Public API: full data ---

  export async function create(
    input: NoteTypes.CreateInput,
    options?: { scopeID?: string },
  ): Promise<z.infer<typeof NoteTypes.Info>> {
    const targetScopeID = options?.scopeID ?? ScopeContext.current.scope.id
    const create = await Plugin.trigger(
      "note.create.before",
      {
        scopeID: targetScopeID,
      },
      {
        note: structuredClone(input),
      },
    )
    const id = Identifier.ascending("note")
    const scopeID = Identifier.asScopeID(targetScopeID)
    const isGlobal = targetScopeID === HOME_SCOPE_ID
    const now = Date.now()
    const blueprint = create.note.blueprint as
      | (NonNullable<NoteTypes.CreateInput["blueprint"]> & { status?: unknown })
      | undefined
    if (blueprint) delete blueprint.status
    const note: z.infer<typeof NoteTypes.Info> = {
      id,
      title: create.note.title,
      content: NoteDocument.normalize(create.note.content),
      pinned: false,
      global: isGlobal,
      archived: false,
      tags: create.note.tags ?? [],
      kind: create.note.kind ?? "note",
      blueprint: blueprint
        ? {
            ...blueprint,
            runCount: blueprint.runCount ?? 0,
          }
        : blueprint,
      version: 1,
      time: { created: now, updated: now },
    }
    await Storage.write(StoragePath.note(scopeID, id), note)
    await indexSet(targetScopeID, note)
    log.info("created", { id, title: note.title, global: isGlobal, scopeID: targetScopeID })
    await Bus.publish(NoteEvent.Created, { scopeID: targetScopeID, note, meta: toMetadata(note) })
    await Plugin.trigger(
      "note.create.after",
      {
        scopeID: targetScopeID,
        noteID: note.id,
      },
      {
        note,
      },
    )
    return note
  }

  export async function get(scopeID: string, noteID: string): Promise<z.infer<typeof NoteTypes.Info>> {
    const note = await Storage.read<z.infer<typeof NoteTypes.Info>>(
      StoragePath.note(Identifier.asScopeID(scopeID), noteID),
    )
    return normalize(note)
  }

  export async function list(
    scopeID: string,
    archiveFilter?: ArchiveFilter,
  ): Promise<z.infer<typeof NoteTypes.Info>[]> {
    const sid = Identifier.asScopeID(scopeID)
    const ids = await Storage.scan(StoragePath.notesRoot(sid))
    if (ids.length === 0) return []
    const keys = ids.filter((id) => !id.startsWith("_")).map((id) => StoragePath.note(sid, id))
    const results = await Storage.readMany<z.infer<typeof NoteTypes.Info>>(keys)
    const notes = results.filter((n): n is z.infer<typeof NoteTypes.Info> => n !== undefined).map(normalize)
    sortByPinAndTime(notes)
    return filterArchive(notes, archiveFilter ?? "active")
  }

  export async function listByKind(scopeID: string, kind: string): Promise<z.infer<typeof NoteTypes.Info>[]> {
    const notes = await list(scopeID)
    return notes.filter((n) => n.kind === kind)
  }

  export async function listWithGlobal(
    scopeID: string,
    archiveFilter?: ArchiveFilter,
  ): Promise<z.infer<typeof NoteTypes.Info>[]> {
    if (scopeID === HOME_SCOPE_ID) return list(HOME_SCOPE_ID, archiveFilter)
    const [local, global] = await Promise.all([list(scopeID, archiveFilter), list(HOME_SCOPE_ID, archiveFilter)])
    return mergeSorted(local, global, comparePinTime)
  }

  export async function listGrouped(archiveFilter?: ArchiveFilter): Promise<NoteTypes.ScopeGroup[]> {
    const scopeIDs = await Storage.scan(["notes"])
    const groups: NoteTypes.ScopeGroup[] = []
    for (const sid of scopeIDs) {
      const notes = await list(sid, archiveFilter)
      groups.push({
        scopeID: sid,
        scopeType: sid === HOME_SCOPE_ID ? "home" : "project",
        notes,
      })
    }
    return groups
  }

  export async function update(
    scopeID: string,
    noteID: string,
    patch: z.infer<typeof NoteTypes.PatchInput>,
  ): Promise<z.infer<typeof NoteTypes.Info>> {
    const sid = Identifier.asScopeID(scopeID)
    const sourcePath = StoragePath.note(sid, noteID)
    const current = normalize(await Storage.read<z.infer<typeof NoteTypes.Info>>(sourcePath))
    const update = await Plugin.trigger(
      "note.update.before",
      {
        scopeID,
        noteID,
        current,
      },
      {
        patch: structuredClone(patch),
      },
    )

    let wasGlobal = false
    const before = structuredClone(current)
    const note = normalize(
      await Storage.update<z.infer<typeof NoteTypes.Info>>(sourcePath, (draft) => {
        draft.global ??= false
        draft.version ??= 1
        wasGlobal = draft.global
        if (update.patch.expectedVersion !== undefined && update.patch.expectedVersion !== draft.version) {
          throw new NoteError.Conflict({
            noteID,
            expectedVersion: update.patch.expectedVersion,
            note: normalize(draft),
          })
        }
        if (update.patch.title !== undefined) draft.title = update.patch.title
        if (update.patch.content !== undefined) draft.content = NoteDocument.normalize(update.patch.content)
        if (update.patch.pinned !== undefined) draft.pinned = update.patch.pinned
        if (update.patch.tags !== undefined) draft.tags = update.patch.tags
        if (update.patch.kind !== undefined) draft.kind = update.patch.kind
        if (update.patch.blueprint === null) {
          draft.blueprint = undefined
        } else if (update.patch.blueprint !== undefined) {
          const { activeLoopID, ...rest } = update.patch.blueprint as z.infer<
            typeof NoteTypes.PatchInput
          >["blueprint"] & {
            status?: unknown
          }
          delete rest.status
          const next = { ...(draft.blueprint ?? {}), ...rest }
          if (activeLoopID !== undefined && activeLoopID !== null) next.activeLoopID = activeLoopID
          if (activeLoopID === null) delete next.activeLoopID
          draft.blueprint = next
        }
        if (update.patch.global !== undefined) draft.global = update.patch.global
        if (update.patch.global === true && !wasGlobal) {
          draft.originScope = sid as string
        }
        if (update.patch.archived !== undefined) {
          draft.archived = update.patch.archived
        }
        draft.version += 1
        draft.time.updated = Date.now()
      }),
    )

    const isNowGlobal = note.global ?? false
    let finalScopeID = scopeID
    if (!wasGlobal && isNowGlobal) {
      const globalSid = Identifier.asScopeID(HOME_SCOPE_ID)
      await Storage.write(StoragePath.note(globalSid, noteID), note)
      await Storage.remove(sourcePath)
      await indexRemove(scopeID, noteID)
      await indexSet(HOME_SCOPE_ID, note)
      finalScopeID = HOME_SCOPE_ID
      log.info("promoted to global", { id: noteID, from: sid })
    } else if (wasGlobal && !isNowGlobal) {
      const targetSid = Identifier.asScopeID(note.originScope || scopeID)
      await Storage.write(StoragePath.note(targetSid, noteID), note)
      await Storage.remove(sourcePath)
      await indexRemove(scopeID, noteID)
      await indexSet(note.originScope || scopeID, note)
      finalScopeID = note.originScope || scopeID
      log.info("demoted from global", { id: noteID, to: targetSid })
    } else {
      await indexSet(scopeID, note)
    }

    const meta = toMetadata(note)
    log.info("updated", { id: noteID, version: note.version })
    await Bus.publish(NoteEvent.Updated, { scopeID: finalScopeID, note, meta, changed: changedFields(before, note) })
    if (patch.archived === true) {
      await Bus.publish(NoteEvent.Archived, { ids: [noteID], scopeID: finalScopeID, metas: [meta] })
    } else if (patch.archived === false) {
      await Bus.publish(NoteEvent.Unarchived, { ids: [noteID], scopeID: finalScopeID, metas: [meta] })
    }
    await Plugin.trigger(
      "note.update.after",
      {
        scopeID,
        noteID,
      },
      {
        note,
      },
    )
    return note
  }

  export async function remove(scopeID: string, noteID: string): Promise<void> {
    const sid = Identifier.asScopeID(scopeID)
    const note = normalize(await Storage.read<z.infer<typeof NoteTypes.Info>>(StoragePath.note(sid, noteID)))
    if (!note.archived) {
      throw new NoteError.NotArchived({
        noteID,
        message: "Note must be archived before it can be deleted. Use note_archive first.",
      })
    }
    await Storage.remove(StoragePath.note(sid, noteID))
    await indexRemove(scopeID, noteID)
    log.info("removed", { id: noteID })
    await Bus.publish(NoteEvent.Deleted, { id: noteID, scopeID })
  }

  async function groupResolvedNoteIDs(scopeID: string, noteIDs: string[]): Promise<Map<string, string[]>> {
    const grouped = new Map<string, string[]>()
    for (const noteID of noteIDs) {
      const resolved = await resolveScope(scopeID, noteID)
      const ids = grouped.get(resolved.scopeID) ?? []
      ids.push(noteID)
      grouped.set(resolved.scopeID, ids)
    }
    return grouped
  }

  async function setArchived(
    scopeID: string,
    noteIDs: string[],
    archived: boolean,
  ): Promise<z.infer<typeof NoteTypes.Info>[]> {
    const grouped = await groupResolvedNoteIDs(scopeID, noteIDs)
    const results: z.infer<typeof NoteTypes.Info>[] = []
    for (const [resolvedScopeID, ids] of grouped) {
      const sid = Identifier.asScopeID(resolvedScopeID)
      const scopedResults: z.infer<typeof NoteTypes.Info>[] = []
      for (const noteID of ids) {
        const sourcePath = StoragePath.note(sid, noteID)
        const note = normalize(
          await Storage.update<z.infer<typeof NoteTypes.Info>>(sourcePath, (draft) => {
            draft.version ??= 1
            draft.archived = archived
            draft.version += 1
            draft.time.updated = Date.now()
          }),
        )
        scopedResults.push(note)
        results.push(note)
      }
      await indexUpdateMany(resolvedScopeID, scopedResults)
      const payload = { ids, scopeID: resolvedScopeID, metas: scopedResults.map(toMetadata) }
      await Bus.publish(archived ? NoteEvent.Archived : NoteEvent.Unarchived, payload)
    }
    log.info(archived ? "archived" : "unarchived", { ids: noteIDs, count: noteIDs.length })
    return results
  }

  export async function archive(scopeID: string, noteIDs: string[]): Promise<z.infer<typeof NoteTypes.Info>[]> {
    return setArchived(scopeID, noteIDs, true)
  }

  export async function unarchive(scopeID: string, noteIDs: string[]): Promise<z.infer<typeof NoteTypes.Info>[]> {
    return setArchived(scopeID, noteIDs, false)
  }

  // --- Public API: metadata only (fast, for tools) ---

  export async function listMeta(scopeID: string, archiveFilter?: ArchiveFilter): Promise<Metadata[]> {
    const entries = await loadIndex(scopeID)
    return filterArchive(entries, archiveFilter ?? "active")
  }

  export async function listMetaWithGlobal(scopeID: string, archiveFilter?: ArchiveFilter): Promise<Metadata[]> {
    if (scopeID === HOME_SCOPE_ID) return listMeta(HOME_SCOPE_ID, archiveFilter)
    const [local, global] = await Promise.all([
      listMeta(scopeID, archiveFilter),
      listMeta(HOME_SCOPE_ID, archiveFilter),
    ])
    return mergeSorted(local, global, comparePinTime)
  }

  export async function listMetaAll(): Promise<Metadata[]> {
    const scopeIDs = await Storage.scan(["notes"])
    const lists = await Promise.all(scopeIDs.map((sid) => listMeta(sid)))
    let result: Metadata[] = []
    for (const list of lists) {
      result = mergeSorted(result, list, comparePinTime)
    }
    return result
  }

  export async function listMetaGrouped(archiveFilter?: ArchiveFilter): Promise<NoteTypes.MetaScopeGroup[]> {
    const scopeIDs = await Storage.scan(["notes"])
    const currentScopeID = ScopeContext.current.scope.id
    scopeIDs.sort((a, b) => {
      if (a === currentScopeID) return -1
      if (b === currentScopeID) return 1
      return a.localeCompare(b)
    })
    const groups = await Promise.all(
      scopeIDs.map(async (sid): Promise<NoteTypes.MetaScopeGroup | undefined> => {
        const metaList = await listMeta(sid, archiveFilter)
        if (metaList.length === 0) return undefined
        return {
          scopeID: sid,
          scopeType: sid === HOME_SCOPE_ID ? "home" : "project",
          notes: metaList,
        }
      }),
    )
    return groups.filter((group): group is NoteTypes.MetaScopeGroup => group !== undefined)
  }

  // --- Public API: scope-agnostic access ---

  export async function getAny(scopeID: string, noteID: string): Promise<z.infer<typeof NoteTypes.Info>> {
    const { note } = await resolveScope(scopeID, noteID)
    return note
  }

  export async function updateAny(
    scopeID: string,
    noteID: string,
    patch: z.infer<typeof NoteTypes.PatchInput>,
  ): Promise<z.infer<typeof NoteTypes.Info>> {
    const { scopeID: resolved } = await resolveScope(scopeID, noteID)
    return update(resolved, noteID, patch)
  }

  export async function removeAny(scopeID: string, noteID: string): Promise<void> {
    const { scopeID: resolved } = await resolveScope(scopeID, noteID)
    return remove(resolved, noteID)
  }
}
