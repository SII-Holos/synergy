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
