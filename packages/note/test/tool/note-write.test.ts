import { describe, expect, test } from "bun:test"
import z from "zod"
import { NoteMarkdown, NoteStore } from "@ericsanchezok/synergy-note"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { NoteWriteTool } from "@ericsanchezok/synergy-note/tools/note-write"
import type { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

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
  test("create, append and replace expose escaped references while preserving resource metadata", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      const scope = (await Scope.fromDirectory(tmp.path)).scope
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const title = "A [draft] *bold* `code` <tag> &copy; \\ path\nNext"
          const created = await execute({ noteTitle: title, noteContent: "First" })
          const id = String(created.metadata.id)
          const line =
            "Reference: [A \\[draft\\] \\*bold\\* \\`code\\` \\<tag\\> &amp;copy; \\\\ path Next](note://" + id + ")"
          expect(created.output.split("\n")).toContain(line)
          expect(created.metadata).toEqual({
            id,
            action: "create",
            title,
            kind: "note",
            scopeID: scope.id,
            truncated: false,
          })
          for (const mode of ["append", "replace"]) {
            const result = await execute({ noteId: id, noteContent: "Next", mode })
            expect(result.output.split("\n")).toContain(line)
            expect(result.metadata).toEqual({ id, action: mode, title, kind: "note", truncated: false })
          }
          const invalid = await execute({ mode: "replace", noteContent: "No ID" })
          expect(invalid.output).not.toContain("note://")
        },
      })
    }))

  test("uses explicit note fields at the agent boundary", () =>
    runtime.run(async () => {
      const tool = await NoteWriteTool.init()
      expect(tool.parameters.safeParse({ noteTitle: "Setup", noteContent: "Read me." }).success).toBe(true)
      expect(tool.parameters.safeParse({ title: "Setup", content: "Read me." }).success).toBe(false)
    }))

  test("replace overwrites the latest note content as a stable full-document write", () =>
    runtime.run(async () => {
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
            noteId: note.id,
            mode: "replace",
            noteContent: "final content",
          })

          const current = await NoteStore.get(scope.id, note.id)
          expect(result.metadata.conflict).toBeUndefined()
          expect(result.metadata.action).toBe("replace")
          expect(markdownText(current.content)).toBe("final content")
        },
      })
    }))
})

afterRuntimeTests(() => runtime.close())
