import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/scope/instance"
import { Scope } from "../../src/scope"
import { NoteError, NoteStore } from "../../src/note"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { Identifier } from "../../src/id/id"
import { Log } from "../../src/util/log"

Log.init({ print: false })

describe("NoteStore", () => {
  test("creates notes in an explicit target scope", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await Instance.provide({
      scope,
      fn: async () => {
        const note = await NoteStore.create(
          {
            title: "Global note",
            contentText: "shared",
          },
          { scopeID: "global" },
        )

        expect(note.global).toBe(true)
        const globalNote = await NoteStore.get("global", note.id)
        expect(globalNote.id).toBe(note.id)
      },
    })
  })

  test("increments version on update", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await Instance.provide({
      scope,
      fn: async () => {
        const created = await NoteStore.create({
          title: "Versioned note",
          contentText: "one",
        })

        expect(created.version).toBe(1)

        const updated = await NoteStore.update(scope.id, created.id, {
          contentText: "two",
          expectedVersion: 1,
        })

        expect(updated.version).toBe(2)
        expect(updated.contentText).toBe("two")
      },
    })
  })

  test("rejects stale expectedVersion", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await Instance.provide({
      scope,
      fn: async () => {
        const created = await NoteStore.create({
          title: "Conflict note",
          contentText: "one",
        })

        await NoteStore.update(scope.id, created.id, {
          contentText: "two",
          expectedVersion: created.version,
        })

        await expect(
          NoteStore.update(scope.id, created.id, {
            contentText: "three",
            expectedVersion: created.version,
          }),
        ).rejects.toBeInstanceOf(NoteError.Conflict)
      },
    })
  })

  test("normalizes legacy notes without version during update", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await Instance.provide({
      scope,
      fn: async () => {
        const noteID = Identifier.ascending("note")
        const now = Date.now()
        await Storage.write(StoragePath.note(Identifier.asScopeID(scope.id), noteID), {
          id: noteID,
          title: "Legacy note",
          content: { type: "doc", content: [] },
          contentText: "legacy",
          pinned: false,
          global: false,
          tags: [],
          time: { created: now, updated: now },
        })

        const updated = await NoteStore.update(scope.id, noteID, {
          contentText: "migrated",
          expectedVersion: 1,
        })

        expect(updated.version).toBe(2)
        expect(updated.contentText).toBe("migrated")
      },
    })
  })
})
