import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { Identifier } from "../id/id"
import { Instance } from "../scope/instance"
import { Bus } from "../bus"
import { NoteEvent } from "./event"
import { NoteTypes } from "./types"
import { NoteError } from "./error"
import { Log } from "../util/log"

export namespace NoteStore {
  const log = Log.create({ service: "note.store" })

  export type Metadata = Omit<NoteTypes.Info, "content">

  function normalize(note: NoteTypes.Info): NoteTypes.Info {
    note.global ??= false
    note.version ??= 1
    return note
  }

  function toMetadata(note: NoteTypes.Info): Metadata {
    const { content: _, ...meta } = note
    return meta
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
    const results = await Storage.readMany<NoteTypes.Info>(keys)
    const entries = results.filter((n): n is NoteTypes.Info => n !== undefined).map((n) => toMetadata(normalize(n)))
    sortByPinAndTime(entries)
    await Storage.write(indexPath(sid), entries)
    log.info("index rebuilt", { scopeID, count: entries.length })
    return entries
  }

  async function indexSet(scopeID: string, note: NoteTypes.Info): Promise<void> {
    const entries = await loadIndex(scopeID)
    const entry = toMetadata(note)
    const idx = entries.findIndex((e) => e.id === note.id)
    if (idx >= 0) entries[idx] = entry
    else entries.push(entry)
    sortByPinAndTime(entries)
    await Storage.write(indexPath(Identifier.asScopeID(scopeID)), entries)
  }

  async function indexRemove(scopeID: string, noteID: string): Promise<void> {
    const entries = await loadIndex(scopeID)
    const filtered = entries.filter((e) => e.id !== noteID)
    await Storage.write(indexPath(Identifier.asScopeID(scopeID)), filtered)
  }

  // --- Scope resolution ---

  async function resolveScope(scopeID: string, noteID: string): Promise<{ scopeID: string; note: NoteTypes.Info }> {
    const sid = Identifier.asScopeID(scopeID)
    try {
      const note = await Storage.read<NoteTypes.Info>(StoragePath.note(sid, noteID))
      return { scopeID, note: normalize(note) }
    } catch {
      // fallthrough
    }
    if (scopeID !== "global") {
      const globalSid = Identifier.asScopeID("global")
      try {
        const note = await Storage.read<NoteTypes.Info>(StoragePath.note(globalSid, noteID))
        return { scopeID: "global", note: normalize(note) }
      } catch {
        // fallthrough
      }
    }
    throw new Storage.NotFoundError({ message: `Note not found: ${noteID}` })
  }

  // --- Public API: full data ---

  export async function create(input: NoteTypes.CreateInput, options?: { scopeID?: string }): Promise<NoteTypes.Info> {
    const targetScopeID = options?.scopeID ?? Instance.scope.id
    const id = Identifier.ascending("note")
    const scopeID = Identifier.asScopeID(targetScopeID)
    const isGlobal = targetScopeID === "global"
    const now = Date.now()
    const note: NoteTypes.Info = {
      id,
      title: input.title,
      content: input.content ?? { type: "doc", content: [] },
      contentText: input.contentText ?? "",
      pinned: false,
      global: isGlobal,
      tags: input.tags ?? [],
      version: 1,
      time: { created: now, updated: now },
    }
    await Storage.write(StoragePath.note(scopeID, id), note)
    await indexSet(targetScopeID, note)
    log.info("created", { id, title: input.title, global: isGlobal, scopeID: targetScopeID })
    await Bus.publish(NoteEvent.Created, { note })
    return note
  }

  export async function get(scopeID: string, noteID: string): Promise<NoteTypes.Info> {
    const note = await Storage.read<NoteTypes.Info>(StoragePath.note(Identifier.asScopeID(scopeID), noteID))
    return normalize(note)
  }

  export async function list(scopeID: string): Promise<NoteTypes.Info[]> {
    const sid = Identifier.asScopeID(scopeID)
    const ids = await Storage.scan(StoragePath.notesRoot(sid))
    if (ids.length === 0) return []
    const keys = ids.filter((id) => !id.startsWith("_")).map((id) => StoragePath.note(sid, id))
    const results = await Storage.readMany<NoteTypes.Info>(keys)
    const notes = results.filter((n): n is NoteTypes.Info => n !== undefined).map(normalize)
    sortByPinAndTime(notes)
    return notes
  }

  export async function listWithGlobal(scopeID: string): Promise<NoteTypes.Info[]> {
    if (scopeID === "global") return list("global")
    const [local, global] = await Promise.all([list(scopeID), list("global")])
    return mergeSorted(local, global, comparePinTime)
  }

  export async function listGrouped(): Promise<NoteTypes.ScopeGroup[]> {
    const scopeIDs = await Storage.scan(["notes"])
    const groups: NoteTypes.ScopeGroup[] = []
    for (const sid of scopeIDs) {
      const notes = await list(sid)
      groups.push({
        scopeID: sid,
        scopeType: sid === "global" ? "global" : "project",
        notes,
      })
    }
    return groups
  }

  export async function update(scopeID: string, noteID: string, patch: NoteTypes.PatchInput): Promise<NoteTypes.Info> {
    const sid = Identifier.asScopeID(scopeID)
    const sourcePath = StoragePath.note(sid, noteID)

    let wasGlobal = false
    const note = await Storage.update<NoteTypes.Info>(sourcePath, (draft) => {
      draft.global ??= false
      draft.version ??= 1
      wasGlobal = draft.global
      if (patch.expectedVersion !== undefined && patch.expectedVersion !== draft.version) {
        throw new NoteError.Conflict({
          noteID,
          expectedVersion: patch.expectedVersion,
          note: normalize(draft),
        })
      }
      if (patch.title !== undefined) draft.title = patch.title
      if (patch.content !== undefined) draft.content = patch.content
      if (patch.contentText !== undefined) draft.contentText = patch.contentText
      if (patch.pinned !== undefined) draft.pinned = patch.pinned
      if (patch.tags !== undefined) draft.tags = patch.tags
      if (patch.global !== undefined) draft.global = patch.global
      if (patch.global === true && !wasGlobal) {
        draft.originScope = sid as string
      }
      draft.version += 1
      draft.time.updated = Date.now()
    })

    const isNowGlobal = note.global ?? false
    if (!wasGlobal && isNowGlobal) {
      const globalSid = Identifier.asScopeID("global")
      await Storage.write(StoragePath.note(globalSid, noteID), note)
      await Storage.remove(sourcePath)
      await indexRemove(scopeID, noteID)
      await indexSet("global", note)
      log.info("promoted to global", { id: noteID, from: sid })
    } else if (wasGlobal && !isNowGlobal) {
      const targetSid = Identifier.asScopeID(note.originScope || scopeID)
      await Storage.write(StoragePath.note(targetSid, noteID), note)
      await Storage.remove(sourcePath)
      await indexRemove(scopeID, noteID)
      await indexSet(note.originScope || scopeID, note)
      log.info("demoted from global", { id: noteID, to: targetSid })
    } else {
      await indexSet(scopeID, note)
    }

    log.info("updated", { id: noteID, version: note.version })
    await Bus.publish(NoteEvent.Updated, { note })
    return note
  }

  export async function remove(scopeID: string, noteID: string): Promise<void> {
    const sid = Identifier.asScopeID(scopeID)
    await Storage.remove(StoragePath.note(sid, noteID))
    await indexRemove(scopeID, noteID)
    log.info("removed", { id: noteID })
    await Bus.publish(NoteEvent.Deleted, { id: noteID, scopeID })
  }

  // --- Public API: metadata only (fast, for tools) ---

  export async function listMeta(scopeID: string): Promise<Metadata[]> {
    return loadIndex(scopeID)
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

  // --- Public API: scope-agnostic access ---

  export async function getAny(scopeID: string, noteID: string): Promise<NoteTypes.Info> {
    const { note } = await resolveScope(scopeID, noteID)
    return note
  }

  export async function updateAny(
    scopeID: string,
    noteID: string,
    patch: NoteTypes.PatchInput,
  ): Promise<NoteTypes.Info> {
    const { scopeID: resolved } = await resolveScope(scopeID, noteID)
    return update(resolved, noteID, patch)
  }

  export async function removeAny(scopeID: string, noteID: string): Promise<void> {
    const { scopeID: resolved } = await resolveScope(scopeID, noteID)
    return remove(resolved, noteID)
  }
}
