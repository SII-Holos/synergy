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
        })

        expect(created.version).toBe(1)

        const updated = await NoteStore.update(scope.id, created.id, {
          expectedVersion: 1,
        })

        expect(updated.version).toBe(2)
        expect(updated.content).toEqual({ type: "doc", content: [] })
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
        })

        await NoteStore.update(scope.id, created.id, {
          expectedVersion: created.version,
        })

        await expect(
          NoteStore.update(scope.id, created.id, {
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
          pinned: false,
          global: false,
          tags: [],
          time: { created: now, updated: now },
        })

        const updated = await NoteStore.update(scope.id, noteID, {
          expectedVersion: 1,
        })

        expect(updated.version).toBe(2)
        expect(updated.content).toEqual({ type: "doc", content: [] })
      },
    })
  })

  test("getAny resolves notes outside the active and global scopes", async () => {
    await using sourceTmp = await tmpdir()
    await using activeTmp = await tmpdir()
    const sourceScope = (await Scope.fromDirectory(sourceTmp.path)).scope
    const activeScope = (await Scope.fromDirectory(activeTmp.path)).scope

    let noteID = ""
    await Instance.provide({
      scope: sourceScope,
      fn: async () => {
        const note = await NoteStore.create({
          title: "Archived source note",
        })
        noteID = note.id
      },
    })

    await Instance.provide({
      scope: activeScope,
      fn: async () => {
        const note = await NoteStore.getAny(activeScope.id, noteID)
        expect(note.title).toBe("Archived source note")
      },
    })
  })

  test("listMetaGrouped returns grouped note metadata without content and with searchText", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await Instance.provide({
      scope,
      fn: async () => {
        const globalNote = await NoteStore.create(
          {
            title: "Global note",
            content: {
              type: "doc",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Global content here" }] }],
            },
          },
          { scopeID: "global" },
        )
        const projectNote = await NoteStore.create({
          title: "Project note",
          content: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "Project content here" }] }],
          },
        })

        const groups = await NoteStore.listMetaGrouped()

        // Should have groups for both scopes
        expect(groups.length).toBeGreaterThanOrEqual(2)

        for (const group of groups) {
          expect(group).toHaveProperty("scopeID")
          expect(group).toHaveProperty("scopeType")
          expect(group).toHaveProperty("notes")
          expect(Array.isArray(group.notes)).toBe(true)

          for (const meta of group.notes) {
            expect(meta).toHaveProperty("id")
            expect(meta).toHaveProperty("title")
            expect(meta).toHaveProperty("pinned")
            expect(meta).toHaveProperty("global")
            expect(meta).toHaveProperty("tags")
            expect(meta).toHaveProperty("version")
            expect(meta).toHaveProperty("time")
            expect(meta.time).toHaveProperty("created")
            expect(meta.time).toHaveProperty("updated")
            expect(meta).toHaveProperty("searchText")
            expect(meta).not.toHaveProperty("content")
            expect(typeof meta.searchText).toBe("string")
          }
        }

        // Verify searchText contains actual note text (pre-computed markdown from index)
        const globalGroup = groups.find((g) => g.scopeID === "global")
        expect(globalGroup).toBeDefined()
        const globalMeta = globalGroup!.notes.find((n) => n.id === globalNote.id)
        expect(globalMeta).toBeDefined()
        expect(globalMeta!.searchText).toContain("Global content")

        // Verify project note is present in its project scope group
        const projectGroup = groups.find((g) => g.scopeID !== "global" && g.notes.some((n) => n.id === projectNote.id))
        expect(projectGroup).toBeDefined()
      },
    })
  })

  test("listMetaGrouped does not load full note content (metadata-only invariant)", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await Instance.provide({
      scope,
      fn: async () => {
        await NoteStore.create({
          title: "Rich note",
          content: {
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Lots of content here" }] },
              { type: "paragraph", content: [{ type: "text", text: "More text" }] },
            ],
          },
        })

        const groups = await NoteStore.listMetaGrouped()

        // Every note in every group must have searchText but NOT content
        for (const group of groups) {
          for (const meta of group.notes) {
            expect(meta).not.toHaveProperty("content")
            expect(meta).toHaveProperty("searchText")
          }
        }

        // searchText must contain the actual note text (proving it comes from the index, not nil)
        const allNotes = groups.flatMap((g) => g.notes)
        expect(allNotes.length).toBeGreaterThan(0)
        for (const meta of allNotes) {
          expect(meta.searchText.length).toBeGreaterThan(0)
        }
      },
    })
  })
})
