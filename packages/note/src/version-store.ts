import { z } from "zod"
import { isDeepEqual } from "remeda"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import type { Migration } from "@ericsanchezok/synergy-harness/migration"
import { NoteTypes } from "./types"

export namespace NoteVersions {
  const Version = z.number().int().positive().safe()
  const ID = z.string().min(1)
  export const key = (scopeID: string, noteID: string, version: number) => [
    "note_versions",
    ID.parse(scopeID),
    ID.parse(noteID),
    String(Version.parse(version)),
  ]

  export async function capture(scopeID: string, input: unknown) {
    return Storage.transaction(async () => {
      const note = NoteTypes.PersistedInfo.parse(JSON.parse(JSON.stringify(input)))
      const path = key(scopeID, note.id, note.version)
      const [previous] = await Storage.readMany([path])
      if (previous !== undefined) {
        if (!isDeepEqual(previous, note))
          throw new Error("An immutable Note version already contains different content")
        return
      }
      await Storage.write(path, note)
    })
  }

  export async function read(scopeID: string, noteID: string, version: number) {
    return NoteTypes.PersistedInfo.parse(await Storage.read(key(scopeID, noteID, version)))
  }
}

export const noteVersionMigration: Migration = {
  id: "20261111-note-retained-versions-v1",
  description: "Retain each provable current Note version without inventing overwritten history",
  scope: "derived",
  execution: "maintenance",
  emptyInput: [["notes"]],
  async up(progress) {
    let count = 0
    for await (const row of Storage.records({ prefix: ["notes"], limit: 128 })) {
      if (row.key.length !== 3 || row.key[2].startsWith("_")) continue
      await Storage.transaction(async () => {
        const [current] = await Storage.readMany([row.key])
        if (current === undefined) return
        const note = NoteTypes.PersistedInfo.parse(current)
        await NoteVersions.capture(row.key[1], note)
      })
      progress(++count, 0)
    }
    progress(count, count)
  },
}
