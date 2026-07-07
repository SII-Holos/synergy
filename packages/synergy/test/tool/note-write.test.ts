import { describe, expect, test } from "bun:test"
import { NoteMarkdown, NoteStore } from "../../src/note"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { NoteWriteTool } from "../../src/tool/note-write"
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
  const tool = await NoteWriteTool.init()
  return tool.execute(input, ctx(session.id))
}

function markdownText(content: unknown) {
  return NoteMarkdown.toMarkdown(content).trim()
}

describe("note_write", () => {
  test("replace overwrites the latest note content as a stable full-document write", async () => {
    await using tmp = await tmpdir()
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const note = await NoteStore.create({
          title: "Replace target",
          content: NoteMarkdown.fromMarkdown("old"),
        })
        await NoteStore.update(scope.id, note.id, {
          expectedVersion: note.version,
          content: NoteMarkdown.fromMarkdown("concurrent update"),
        })

        const result = await execute({
          id: note.id,
          mode: "replace",
          content: "final content",
        })

        const current = await NoteStore.get(scope.id, note.id)
        expect(result.metadata.conflict).toBeUndefined()
        expect(result.metadata.action).toBe("replace")
        expect(markdownText(current.content)).toBe("final content")
      },
    })
  })
})
