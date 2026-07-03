import { describe, expect, test } from "bun:test"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { NoteDocument, NoteStore } from "../../src/note"
import { Session } from "../../src/session"
import { NoteEditTool } from "../../src/tool/note-edit"
import type { Tool } from "../../src/tool/tool"
import { tmpdir } from "../fixture/fixture"

function ctx(sessionID: string): Tool.Context {
  return {
    sessionID,
    messageID: "",
    callID: "",
    agent: "test-strategist",
    abort: AbortSignal.any([]),
    metadata: () => {},
    ask: async () => {},
  }
}

async function execute(input: any) {
  const session = await Session.create({})
  const tool = await NoteEditTool.init()
  return tool.execute(input, ctx(session.id))
}

function paragraph(text: string) {
  return { type: "paragraph", content: [{ type: "text", text }] }
}

function noteText(content: unknown) {
  return NoteDocument.listBlocks(content)
    .filter((block) => block.type === "paragraph" || block.type === "tableCell" || block.type === "tableHeader")
    .map((block) => block.text.trim())
}

describe("note_edit anchored operations", () => {
  test("rejects stale baseVersion without writing", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const note = await NoteStore.create({
          title: "Version guard",
          content: { type: "doc", content: [paragraph("old")] },
        })
        const block = NoteDocument.listBlocks(note.content)[0]
        await NoteStore.update(scope.id, note.id, { expectedVersion: note.version })

        const result = await execute({
          id: note.id,
          baseVersion: note.version,
          ops: [
            {
              action: "replaceBlock",
              blockId: block.id,
              expectedHash: block.hash,
              content: { format: "text", text: "new" },
            },
          ],
        })

        const current = await NoteStore.get(scope.id, note.id)
        expect(result.metadata.errorCode).toBe("VERSION_MISMATCH")
        expect(noteText(current.content)).toContain("old")
      },
    })
  })

  test("rejects block hash mismatch without writing", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const note = await NoteStore.create({
          title: "Hash guard",
          content: { type: "doc", content: [paragraph("old")] },
        })
        const block = NoteDocument.listBlocks(note.content)[0]

        const result = await execute({
          id: note.id,
          baseVersion: note.version,
          baseDocHash: NoteDocument.hash(note.content),
          ops: [
            {
              action: "replaceBlock",
              blockId: block.id,
              expectedHash: "wrong",
              content: { format: "text", text: "new" },
            },
          ],
        })

        const current = await NoteStore.get(scope.id, note.id)
        expect(result.metadata.errorCode).toBe("EDIT_PRECONDITION_FAILED")
        expect(noteText(current.content)).toContain("old")
      },
    })
  })

  test("re-resolves blockId after earlier insertions in the same edit", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const note = await NoteStore.create({
          title: "Stable anchor",
          content: { type: "doc", content: [paragraph("A"), paragraph("B")] },
        })
        const blocks = NoteDocument.listBlocks(note.content)
        const b = blocks.find((block) => block.text.trim() === "B")!

        await execute({
          id: note.id,
          baseVersion: note.version,
          baseDocHash: NoteDocument.hash(note.content),
          ops: [
            {
              action: "insertBefore",
              blockId: b.id,
              content: { format: "text", text: "X" },
            },
            {
              action: "replaceBlock",
              blockId: b.id,
              expectedHash: b.hash,
              content: { format: "text", text: "C" },
            },
          ],
        })

        const current = await NoteStore.get(scope.id, note.id)
        expect(noteText(current.content).slice(0, 3)).toEqual(["A", "X", "C"])
      },
    })
  })

  test("replaceBlock consumes the old block", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const note = await NoteStore.create({
          title: "Anchored replace",
          content: { type: "doc", content: [paragraph("old block"), paragraph("keep")] },
        })
        const old = NoteDocument.listBlocks(note.content)[0]

        const result = await execute({
          id: note.id,
          baseVersion: note.version,
          baseDocHash: NoteDocument.hash(note.content),
          ops: [
            {
              action: "replaceBlock",
              blockId: old.id,
              expectedHash: old.hash,
              content: { format: "text", text: "new block" },
            },
          ],
        })

        const current = await NoteStore.get(scope.id, note.id)
        const text = noteText(current.content)
        expect(result.metadata.errorCode).toBeUndefined()
        expect(text).toContain("new block")
        expect(text).toContain("keep")
        expect(text).not.toContain("old block")
      },
    })
  })

  test("replaceText fails when find is ambiguous", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const note = await NoteStore.create({
          title: "Ambiguous text",
          content: { type: "doc", content: [paragraph("target and target")] },
        })
        const block = NoteDocument.listBlocks(note.content)[0]

        const result = await execute({
          id: note.id,
          baseVersion: note.version,
          baseDocHash: NoteDocument.hash(note.content),
          ops: [
            {
              action: "replaceText",
              blockId: block.id,
              expectedHash: block.hash,
              find: "target",
              replacement: "done",
            },
          ],
        })

        const current = await NoteStore.get(scope.id, note.id)
        expect(result.metadata.errorCode).toBe("EDIT_PRECONDITION_FAILED")
        expect(noteText(current.content)).toContain("target and target")
      },
    })
  })

  test("replaceText uses the same text coordinates it shows for marked inline text", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const note = await NoteStore.create({
          title: "Inline mark coordinates",
          content: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "prefix " },
                  { type: "text", text: "CODE", marks: [{ type: "code" }] },
                  { type: "text", text: " before TARGET after" },
                ],
              },
            ],
          },
        })
        const block = NoteDocument.listBlocks(note.content)[0]

        const result = await execute({
          id: note.id,
          baseVersion: note.version,
          baseDocHash: NoteDocument.hash(note.content),
          ops: [
            {
              action: "replaceText",
              blockId: block.id,
              expectedHash: block.hash,
              find: "TARGET",
              replacement: "DONE",
            },
          ],
        })

        const current = await NoteStore.get(scope.id, note.id)
        const [currentBlock] = NoteDocument.listBlocks(current.content, { includeJson: true })
        expect(result.metadata.errorCode).toBeUndefined()
        expect(currentBlock.text).toBe("prefix CODE before DONE after")
        expect(currentBlock.json?.content?.[1]?.marks).toEqual([{ type: "code" }])
      },
    })
  })

  test("replaceText accounts for hardBreak offsets and rejects spans through hardBreaks", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const content = {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "before" }, { type: "hardBreak" }, { type: "text", text: "after" }],
            },
          ],
        }
        const editableNote = await NoteStore.create({ title: "Hard break offset", content })
        const editableBlock = NoteDocument.listBlocks(editableNote.content)[0]

        const editResult = await execute({
          id: editableNote.id,
          baseVersion: editableNote.version,
          baseDocHash: NoteDocument.hash(editableNote.content),
          ops: [
            {
              action: "replaceText",
              blockId: editableBlock.id,
              expectedHash: editableBlock.hash,
              find: "after",
              replacement: "done",
            },
          ],
        })

        const edited = await NoteStore.get(scope.id, editableNote.id)
        const [editedBlock] = NoteDocument.listBlocks(edited.content)
        expect(editResult.metadata.errorCode).toBeUndefined()
        expect(editedBlock.text).toBe("before\ndone")

        const guardedNote = await NoteStore.create({ title: "Hard break guard", content })
        const guardedBlock = NoteDocument.listBlocks(guardedNote.content)[0]
        const guardResult = await execute({
          id: guardedNote.id,
          baseVersion: guardedNote.version,
          baseDocHash: NoteDocument.hash(guardedNote.content),
          ops: [
            {
              action: "replaceText",
              blockId: guardedBlock.id,
              expectedHash: guardedBlock.hash,
              find: "before\nafter",
              replacement: "bad",
            },
          ],
        })

        const guarded = await NoteStore.get(scope.id, guardedNote.id)
        const [currentGuardedBlock] = NoteDocument.listBlocks(guarded.content)
        expect(guardResult.metadata.errorCode).toBe("EDIT_PRECONDITION_FAILED")
        expect(currentGuardedBlock.text).toBe("before\nafter")
      },
    })
  })

  test("replaceText accounts for nested block separators", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const note = await NoteStore.create({
          title: "Nested separators",
          content: {
            type: "doc",
            content: [
              {
                type: "blockquote",
                content: [paragraph("first"), paragraph("second TARGET")],
              },
            ],
          },
        })
        const blockquote = NoteDocument.listBlocks(note.content).find((block) => block.type === "blockquote")!

        const result = await execute({
          id: note.id,
          baseVersion: note.version,
          baseDocHash: NoteDocument.hash(note.content),
          ops: [
            {
              action: "replaceText",
              blockId: blockquote.id,
              expectedHash: blockquote.hash,
              find: "TARGET",
              replacement: "done",
            },
          ],
        })

        const current = await NoteStore.get(scope.id, note.id)
        const currentBlockquote = NoteDocument.listBlocks(current.content).find((block) => block.type === "blockquote")!
        expect(result.metadata.errorCode).toBeUndefined()
        expect(currentBlockquote.text).toBe("first\nsecond done")
      },
    })
  })

  test("updates a table cell without changing adjacent cells", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const note = await NoteStore.create({
          title: "Table edit",
          content: {
            type: "doc",
            content: [
              {
                type: "table",
                content: [
                  {
                    type: "tableRow",
                    content: [
                      { type: "tableCell", content: [paragraph("left")] },
                      { type: "tableCell", content: [paragraph("right")] },
                    ],
                  },
                ],
              },
            ],
          },
        })
        const cell = NoteDocument.listBlocks(note.content).find(
          (block) => block.type === "tableCell" && block.col === 1,
        )!

        await execute({
          id: note.id,
          baseVersion: note.version,
          baseDocHash: NoteDocument.hash(note.content),
          ops: [
            {
              action: "updateTableCell",
              cellId: cell.id,
              expectedHash: cell.hash,
              content: { format: "text", text: "changed" },
            },
          ],
        })

        const current = await NoteStore.get(scope.id, note.id)
        expect(noteText(current.content)).toContain("left")
        expect(noteText(current.content)).toContain("changed")
        expect(noteText(current.content)).not.toContain("right")
      },
    })
  })

  test("dryRun validates edits without updating version or content", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const note = await NoteStore.create({
          title: "Dry run",
          content: { type: "doc", content: [paragraph("old")] },
        })
        const block = NoteDocument.listBlocks(note.content)[0]

        const result = await execute({
          id: note.id,
          baseVersion: note.version,
          baseDocHash: NoteDocument.hash(note.content),
          dryRun: true,
          ops: [
            {
              action: "replaceBlock",
              blockId: block.id,
              expectedHash: block.hash,
              content: { format: "text", text: "new" },
            },
          ],
        })

        const current = await NoteStore.get(scope.id, note.id)
        expect(result.metadata.dryRun).toBe(true)
        expect(current.version).toBe(note.version)
        expect(noteText(current.content)).toContain("old")
      },
    })
  })
})
