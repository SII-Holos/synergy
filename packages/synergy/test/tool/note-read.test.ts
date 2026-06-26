import { describe, expect, test } from "bun:test"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { NoteStore } from "../../src/note"
import { NoteReadTool } from "../../src/tool/note-read"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: "test-note-read",
  messageID: "",
  callID: "",
  agent: "test-strategist",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

async function execute(input: any) {
  const tool = await NoteReadTool.init()
  return tool.execute(input, ctx)
}

function paragraph(text: string) {
  return { type: "paragraph", content: [{ type: "text", text }] }
}

describe("note_read blocks output", () => {
  test("emits versioned block anchors and paginates by block entries", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const note = await NoteStore.create({
          title: "Readable blocks",
          content: {
            type: "doc",
            content: [
              paragraph("first"),
              { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "line1\nline2" }] },
              paragraph("third"),
            ],
          },
        })

        const result = await execute({
          ids: [note.id],
          format: "blocks",
          offset: 1,
          limit: 1,
        })

        expect(result.output).toContain(`Version: ${note.version}`)
        expect(result.output).toContain("DocHash: ")
        expect(result.output).toContain("BlockCount: 3")
        expect(result.output).toContain("ShowingBlocks: 1-1")
        expect(result.output).toContain("[block:1]")
        expect(result.output).toContain("id=blk_")
        expect(result.output).toContain("type=codeBlock")
        expect(result.output).toContain("hash=")
        expect(result.output).toContain("codeBlock:ts")
        expect(result.output).not.toContain("[block:0]")
        expect(result.output).not.toContain("[block:2]")
      },
    })
  })
})
