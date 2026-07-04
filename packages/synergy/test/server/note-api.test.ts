import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { NoteError, NoteStore } from "../../src/note"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"

Log.init({ print: false })

describe("Note conflict payloads", () => {
  test("returns the current note in stale-version conflicts", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const created = await NoteStore.create({
          title: "Test note",
        })

        await NoteStore.update(scope.id, created.id, {
          expectedVersion: created.version,
        })

        await expect(
          NoteStore.update(scope.id, created.id, {
            expectedVersion: created.version,
          }),
        ).rejects.toMatchObject({
          name: "NoteConflictError",
          data: {
            expectedVersion: created.version,
            note: expect.objectContaining({
              id: created.id,
              version: created.version + 1,
            }),
          },
        })
      },
    })
  })
})

describe("GET /note/meta metadata route", () => {
  test("returns grouped metadata without content but with searchText", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await NoteStore.create(
          {
            title: "API note",
            content: {
              type: "doc",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Hello from the API" }] }],
            },
          },
          { scopeID: "home" },
        )
        await NoteStore.create({
          title: "Local note",
          content: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "Local content" }] }],
          },
        })
      },
    })

    // Request through the Hono app, scoping by directory
    const app = Server.App()
    const res = await app.request(`/note/meta?directory=${encodeURIComponent(tmp.path)}`)
    expect(res.status).toBe(200)

    const groups = (await res.json()) as Array<Record<string, unknown>>
    expect(Array.isArray(groups)).toBe(true)
    expect(groups.length).toBeGreaterThanOrEqual(2)

    for (const group of groups) {
      expect(group).toHaveProperty("scopeID")
      expect(group).toHaveProperty("scopeType")
      expect(group).toHaveProperty("notes")
      const notes = group.notes as Array<Record<string, unknown>>
      expect(Array.isArray(notes)).toBe(true)

      for (const meta of notes) {
        expect(meta).toHaveProperty("id")
        expect(meta).toHaveProperty("title")
        expect(meta).toHaveProperty("searchText")
        expect(meta).not.toHaveProperty("content")
      }
    }

    // searchText should contain real text
    const allMetas = groups.flatMap((g) => (g.notes as Array<Record<string, unknown>>) ?? [])
    expect(allMetas.length).toBeGreaterThan(0)
    for (const meta of allMetas) {
      expect(typeof meta.searchText).toBe("string")
      expect((meta.searchText as string).length).toBeGreaterThan(0)
    }
  })

  test("/note/meta response does not expose note content", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await NoteStore.create({
          title: "Secret note",
          content: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "Secret sauce recipe" }] }],
          },
        })
      },
    })

    const app = Server.App()
    const res = await app.request(`/note/meta?directory=${encodeURIComponent(tmp.path)}`)
    expect(res.status).toBe(200)

    const groups = (await res.json()) as Array<Record<string, unknown>>
    for (const group of groups) {
      const notes = group.notes as Array<Record<string, unknown>>
      for (const meta of notes) {
        expect(meta).not.toHaveProperty("content")
      }
    }
  })

  test("/note/all (legacy) still returns notes with content for compatibility", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await NoteStore.create({
          title: "Legacy route note",
          content: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "Old route content" }] }],
          },
        })
      },
    })

    const app = Server.App()
    const res = await app.request(`/note/all?directory=${encodeURIComponent(tmp.path)}`)
    expect(res.status).toBe(200)

    const groups = (await res.json()) as Array<Record<string, unknown>>
    expect(groups.length).toBeGreaterThan(0)

    // At least one note should have content via legacy route
    let hasContent = false
    for (const group of groups) {
      const notes = group.notes as Array<Record<string, unknown>>
      for (const note of notes) {
        if (note.content) hasContent = true
      }
    }
    expect(hasContent).toBe(true)
  })

  test("/note/:id still returns full note with content", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    let noteId = ""

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const created = await NoteStore.create({
          title: "Get-by-id note",
          content: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "Get me by ID" }] }],
          },
        })
        noteId = created.id
      },
    })

    const app = Server.App()
    const res = await app.request(`/note/${noteId}?directory=${encodeURIComponent(tmp.path)}`)
    expect(res.status).toBe(200)

    const note = (await res.json()) as Record<string, unknown>
    expect(note.id).toBe(noteId)
    expect(note).toHaveProperty("content")
  })
})

describe("Note archive and delete routes", () => {
  test("PUT /note/:id with { archived: true } archives the note", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope
    let noteId = ""

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const created = await NoteStore.create({ title: "To archive" })
        noteId = created.id
      },
    })

    const app = Server.App()
    const res = await app.request(`/note/${noteId}?directory=${encodeURIComponent(tmp.path)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    })
    expect(res.status).toBe(200)

    const updated = (await res.json()) as Record<string, unknown>
    expect(updated.archived).toBe(true)
    expect(updated.id).toBe(noteId)
  })

  test("PUT /note/:id with { archived: false } unarchives the note", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope
    let noteId = ""

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const created = await NoteStore.create({ title: "To unarchive" })
        noteId = created.id
        await NoteStore.update(scope.id, noteId, { archived: true })
      },
    })

    const app = Server.App()
    const res = await app.request(`/note/${noteId}?directory=${encodeURIComponent(tmp.path)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: false }),
    })
    expect(res.status).toBe(200)

    const updated = (await res.json()) as Record<string, unknown>
    expect(updated.archived).toBe(false)
    expect(updated.id).toBe(noteId)
  })

  test("DELETE /note/:id on active note returns 409 NoteNotArchivedError and note remains accessible", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope
    let noteId = ""

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const created = await NoteStore.create({ title: "Active note" })
        noteId = created.id
      },
    })

    const app = Server.App()
    const deleteRes = await app.request(`/note/${noteId}?directory=${encodeURIComponent(tmp.path)}`, {
      method: "DELETE",
    })
    expect(deleteRes.status).toBe(409)

    const body = (await deleteRes.json()) as Record<string, unknown>
    expect(body.name).toBe("NoteNotArchivedError")

    // Note should still be accessible
    const getRes = await app.request(`/note/${noteId}?directory=${encodeURIComponent(tmp.path)}`)
    expect(getRes.status).toBe(200)
    const note = (await getRes.json()) as Record<string, unknown>
    expect(note.id).toBe(noteId)
  })

  test("DELETE /note/:id on archived note returns 200 true and then GET returns not found", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope
    let noteId = ""

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const created = await NoteStore.create({ title: "To delete" })
        noteId = created.id
        await NoteStore.update(scope.id, noteId, { archived: true })
      },
    })

    const app = Server.App()
    const deleteRes = await app.request(`/note/${noteId}?directory=${encodeURIComponent(tmp.path)}`, {
      method: "DELETE",
    })
    expect(deleteRes.status).toBe(200)
    expect(await deleteRes.json()).toBe(true)

    // Verify note is gone
    const getRes = await app.request(`/note/${noteId}?directory=${encodeURIComponent(tmp.path)}`)
    expect(getRes.status).toBe(404)
  })

  test("GET /note/meta excludes archived notes by default", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope
    let activeNoteId = ""
    let archivedNoteId = ""

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const active = await NoteStore.create({ title: "Active visible note" })
        activeNoteId = active.id
        const archived = await NoteStore.create({ title: "Archived hidden note" })
        archivedNoteId = archived.id
        await NoteStore.update(scope.id, archivedNoteId, { archived: true })
      },
    })

    const app = Server.App()
    const res = await app.request(`/note/meta?directory=${encodeURIComponent(tmp.path)}`)
    expect(res.status).toBe(200)

    const groups = (await res.json()) as Array<Record<string, unknown>>
    const allIds = groups.flatMap((g) => (g.notes as Array<Record<string, unknown>>).map((n) => n.id))
    expect(allIds).toContain(activeNoteId)
    expect(allIds).not.toContain(archivedNoteId)
  })

  test("GET /note/meta?archived=true returns archived notes only", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope
    let activeNoteId = ""
    let archivedNoteId = ""

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const active = await NoteStore.create({ title: "Active note" })
        activeNoteId = active.id
        const archived = await NoteStore.create({ title: "Archived note" })
        archivedNoteId = archived.id
        await NoteStore.update(scope.id, archivedNoteId, { archived: true })
      },
    })

    const app = Server.App()
    const res = await app.request(`/note/meta?directory=${encodeURIComponent(tmp.path)}&archived=true`)
    expect(res.status).toBe(200)

    const groups = (await res.json()) as Array<Record<string, unknown>>
    const allIds = groups.flatMap((g) => (g.notes as Array<Record<string, unknown>>).map((n) => n.id))
    expect(allIds).toContain(archivedNoteId)
    expect(allIds).not.toContain(activeNoteId)
  })
})
