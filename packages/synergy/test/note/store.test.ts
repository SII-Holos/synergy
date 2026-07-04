import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
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

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const note = await NoteStore.create(
          {
            title: "Global note",
          },
          { scopeID: "home" },
        )

        expect(note.global).toBe(true)
        const globalNote = await NoteStore.get("home", note.id)
        expect(globalNote.id).toBe(note.id)
      },
    })
  })

  test("increments version on update", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
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

    await ScopeContext.provide({
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

    await ScopeContext.provide({
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

  test("getAny resolves notes outside the active and home scopes", async () => {
    await using sourceTmp = await tmpdir()
    await using activeTmp = await tmpdir()
    const sourceScope = (await Scope.fromDirectory(sourceTmp.path)).scope
    const activeScope = (await Scope.fromDirectory(activeTmp.path)).scope

    let noteID = ""
    await ScopeContext.provide({
      scope: sourceScope,
      fn: async () => {
        const note = await NoteStore.create({
          title: "Archived source note",
        })
        noteID = note.id
      },
    })

    await ScopeContext.provide({
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

    await ScopeContext.provide({
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
          { scopeID: "home" },
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
        const globalGroup = groups.find((g) => g.scopeID === "home")
        expect(globalGroup).toBeDefined()
        const globalMeta = globalGroup!.notes.find((n) => n.id === globalNote.id)
        expect(globalMeta).toBeDefined()
        expect(globalMeta!.searchText).toContain("Global content")

        // Verify project note is present in its project scope group
        const projectGroup = groups.find((g) => g.scopeID !== "home" && g.notes.some((n) => n.id === projectNote.id))
        expect(projectGroup).toBeDefined()
      },
    })
  })

  test("listMetaGrouped does not load full note content (metadata-only invariant)", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
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

  test("archived defaults to false on create", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const note = await NoteStore.create({ title: "Default archived" })
        expect(note.archived).toBe(false)
      },
    })
  })

  test("archive sets archived to true and preserves note data", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const created = await NoteStore.create({
          title: "To archive",
          content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Data" }] }] },
          tags: ["tag1"],
        })
        const archived = await NoteStore.archive(scope.id, [created.id])
        expect(archived[0].archived).toBe(true)
        expect(archived[0].title).toBe("To archive")
        expect(archived[0].tags).toEqual(["tag1"])
        expect(archived[0].id).toBe(created.id)
      },
    })
  })

  test("unarchive restores active state without data loss", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const created = await NoteStore.create({
          title: "To unarchive",
          content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Restore me" }] }] },
          tags: ["keep"],
        })
        await NoteStore.archive(scope.id, [created.id])
        const restored = await NoteStore.unarchive(scope.id, [created.id])
        expect(restored[0].archived).toBe(false)
        expect(restored[0].title).toBe("To unarchive")
        expect(restored[0].tags).toEqual(["keep"])
      },
    })
  })

  test("list defaults to active notes only", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const active = await NoteStore.create({ title: "Active note" })
        const archived = await NoteStore.create({ title: "Archived note" })
        await NoteStore.archive(scope.id, [archived.id])

        const list = await NoteStore.list(scope.id)
        expect(list.length).toBe(1)
        expect(list[0].id).toBe(active.id)
      },
    })
  })

  test("list with all filter includes archived notes", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const active = await NoteStore.create({ title: "Active note" })
        const archived = await NoteStore.create({ title: "Archived note" })
        await NoteStore.archive(scope.id, [archived.id])

        const list = await NoteStore.list(scope.id, "all")
        expect(list.length).toBe(2)
        const ids = list.map((n) => n.id)
        expect(ids).toContain(active.id)
        expect(ids).toContain(archived.id)
      },
    })
  })

  test("listMetaWithGlobal defaults to active notes only", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const active = await NoteStore.create({ title: "Active note" })
        const archived = await NoteStore.create({ title: "Will archive" })
        await NoteStore.archive(scope.id, [archived.id])

        const meta = await NoteStore.listMetaWithGlobal(scope.id)
        const ids = meta.map((m) => m.id)
        expect(ids).toContain(active.id)
        expect(ids).not.toContain(archived.id)
      },
    })
  })

  test("remove rejects active notes with NoteError.NotArchived", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const note = await NoteStore.create({ title: "Cannot remove yet" })
        await expect(NoteStore.remove(scope.id, note.id)).rejects.toBeInstanceOf(NoteError.NotArchived)
      },
    })
  })

  test("remove succeeds for archived notes", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const note = await NoteStore.create({ title: "Can remove after archive" })
        await NoteStore.archive(scope.id, [note.id])
        await NoteStore.remove(scope.id, note.id)
        await expect(NoteStore.get(scope.id, note.id)).rejects.toBeInstanceOf(Storage.NotFoundError)
      },
    })
  })

  test("removeAny cannot bypass the archived-only delete gate", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const note = await NoteStore.create({ title: "Blocked from removeAny" })
        await expect(NoteStore.removeAny(scope.id, note.id)).rejects.toBeInstanceOf(NoteError.NotArchived)
      },
    })
  })

  test("archived notes remain readable by get", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const note = await NoteStore.create({
          title: "Still accessible",
          content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Present" }] }] },
        })
        await NoteStore.archive(scope.id, [note.id])
        const fetched = await NoteStore.get(scope.id, note.id)
        expect(fetched.title).toBe("Still accessible")
        expect(fetched.archived).toBe(true)
      },
    })
  })

  test("archive/unarchive preserves content, title, tags, pinned", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const content = {
          type: "doc" as const,
          content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text: "Preserved text" }] }],
        }
        const note = await NoteStore.create({
          title: "Full data note",
          content,
          tags: ["a", "b"],
        })

        await NoteStore.update(scope.id, note.id, { expectedVersion: note.version, pinned: true })
        await NoteStore.archive(scope.id, [note.id])
        const restored = await NoteStore.unarchive(scope.id, [note.id])
        expect(restored[0].title).toBe("Full data note")
        expect(restored[0].tags).toEqual(["a", "b"])
        expect(restored[0].archived).toBe(false)

        const fetched = await NoteStore.get(scope.id, note.id)
        expect(fetched.title).toBe("Full data note")
        expect(fetched.tags).toEqual(["a", "b"])
        expect(fetched.pinned).toBe(true)
      },
    })
  })

  test("archived filter returns archived notes", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await NoteStore.create({ title: "Active note" })
        const archived = await NoteStore.create({ title: "Archived note" })
        await NoteStore.archive(scope.id, [archived.id])

        const list = await NoteStore.list(scope.id, "archived")
        expect(list.length).toBe(1)
        expect(list[0].id).toBe(archived.id)
      },
    })
  })
})
