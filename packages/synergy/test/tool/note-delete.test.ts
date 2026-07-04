import { describe, expect, test } from "bun:test"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { NoteStore } from "../../src/note"
import { NoteDeleteTool } from "../../src/tool/note-delete"
import { NoteArchiveTool } from "../../src/tool/note-archive"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: "test-note-delete",
  messageID: "",
  callID: "",
  agent: "test-strategist",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

async function execute(input: any) {
  const tool = await NoteDeleteTool.init()
  return tool.execute(input, ctx)
}

function paragraph(text: string) {
  return { type: "paragraph", content: [{ type: "text", text }] }
}

describe("note_delete", () => {
  test("returns archive-first error for active notes and does not delete them", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const note = await NoteStore.create({
          title: "Active note",
          content: { type: "doc", content: [paragraph("keep me")] },
        })

        const result = await execute({ id: note.id })

        expect(result.title).toBe("Cannot delete active note")
        expect(result.output).toContain("must be archived")
        expect(result.output).toContain(`"${note.title}"`)
        expect(result.output).toContain(`[${note.id}]`)
        expect(result.metadata.id).toBe(note.id)
        expect(result.metadata.archived).toBe(false)

        const current = await NoteStore.get(scope.id, note.id)
        expect(current).toBeDefined()
        expect(current.title).toBe("Active note")
      },
    })
  })

  test("permanently deletes archived notes", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const note = await NoteStore.create({
          title: "To delete",
          content: { type: "doc", content: [paragraph("goodbye")] },
        })

        const archiveTool = await NoteArchiveTool.init()
        await archiveTool.execute(
          { ids: [note.id], unarchive: false },
          {
            sessionID: "test-note-delete",
            messageID: "",
            callID: "",
            agent: "test-strategist",
            abort: AbortSignal.any([]),
            metadata: () => {},
            ask: async () => {},
          },
        )

        const result = await execute({ id: note.id })

        expect(result.title).toBe("Deleted note")
        expect(result.output).toContain("Permanently deleted")
        expect(result.output).toContain(`"${note.title}"`)
        expect(result.output).toContain(`[${note.id}]`)
        expect(result.metadata.id).toBe(note.id)
        expect(result.metadata.archived).toBe(true)

        try {
          await NoteStore.get(scope.id, note.id)
          expect.unreachable("Expected get to throw after permanent deletion")
        } catch (err: any) {
          expect(err).toBeDefined()
        }
      },
    })
  })
})
