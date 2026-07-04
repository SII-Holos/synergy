import { describe, expect, test } from "bun:test"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { NoteStore } from "../../src/note"
import { NoteArchiveTool } from "../../src/tool/note-archive"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: "test-note-archive",
  messageID: "",
  callID: "",
  agent: "test-strategist",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

async function execute(input: any) {
  const tool = await NoteArchiveTool.init()
  return tool.execute(input, ctx)
}

function paragraph(text: string) {
  return { type: "paragraph", content: [{ type: "text", text }] }
}

describe("note_archive", () => {
  test("archives multiple notes", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const a = await NoteStore.create({
          title: "Alpha",
          content: { type: "doc", content: [paragraph("a")] },
        })
        const b = await NoteStore.create({
          title: "Beta",
          content: { type: "doc", content: [paragraph("b")] },
        })

        const result = await execute({ ids: [a.id, b.id] })

        expect(result.title).toBe("Archived 2 notes")
        expect(result.output).toContain("Archived 2 notes")
        expect(result.output).toContain(`[${a.id}] "Alpha"`)
        expect(result.output).toContain(`[${b.id}] "Beta"`)
        expect(result.metadata.count).toBe(2)
        expect(result.metadata.action).toBe("archive")

        const archivedA = await NoteStore.get(scope.id, a.id)
        const archivedB = await NoteStore.get(scope.id, b.id)
        expect(archivedA.archived).toBe(true)
        expect(archivedB.archived).toBe(true)
      },
    })
  })

  test("is idempotent - archiving already archived note is not an error", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const note = await NoteStore.create({
          title: "Already archived",
          content: { type: "doc", content: [paragraph("x")] },
        })

        await execute({ ids: [note.id] })
        const result = await execute({ ids: [note.id] })

        expect(result.title).toBe("Archived 1 note")
        expect(result.output).toContain(`[${note.id}]`)
        expect(result.metadata.action).toBe("archive")

        const current = await NoteStore.get(scope.id, note.id)
        expect(current.archived).toBe(true)
      },
    })
  })

  test("unarchives notes with unarchive: true", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const note = await NoteStore.create({
          title: "To restore",
          content: { type: "doc", content: [paragraph("r")] },
        })

        await execute({ ids: [note.id] })
        const archived = await NoteStore.get(scope.id, note.id)
        expect(archived.archived).toBe(true)

        const result = await execute({ ids: [note.id], unarchive: true })

        expect(result.title).toBe("Unarchived 1 note")
        expect(result.output).toContain("Restored 1 note")
        expect(result.output).toContain(`[${note.id}] "To restore"`)
        expect(result.metadata.count).toBe(1)
        expect(result.metadata.action).toBe("unarchive")

        const current = await NoteStore.get(scope.id, note.id)
        expect(current.archived).toBe(false)
      },
    })
  })
})
