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
import { testRuntime } from "./runtime"
import { lattice } from "@ericsanchezok/synergy-lattice/component"
const runtime = await testRuntime({ register: () => lattice().register() })

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

describe("Blueprint note writer", () => {
  test("does not expose or persist a model-selected Blueprint default agent", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      const scope = (await Scope.fromDirectory(tmp.path)).scope

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const session = await Session.create({})
          await Session.update(session.id, (draft) => {
            draft.workflow = { kind: "lattice", runID: "ltr_test", mode: "auto" }
          })
          const tool = await NoteWriteTool.init()
          const schema = z.toJSONSchema(tool.parameters) as { properties?: Record<string, unknown> }

          expect(schema.properties).not.toHaveProperty("defaultAgent")

          const legacyInput = {
            mode: "create",
            noteTitle: "Model-authored Blueprint",
            noteContent: "Execute the current Step.",
            kind: "blueprint",
            defaultAgent: "implementation-engineer",
            scope: "current",
          } as unknown as Parameters<typeof tool.execute>[0]
          await expect(tool.execute(legacyInput, ctx(session.id))).rejects.toThrow("invalid arguments")

          const existing = await NoteStore.create({
            title: "User-configured Blueprint",
            content: NoteMarkdown.fromMarkdown("Original"),
            kind: "blueprint",
            blueprint: { defaultAgent: "developer" },
          })
          await tool.execute(
            {
              mode: "replace",
              noteId: existing.id,
              noteContent: "Updated",
              scope: "current",
            },
            ctx(session.id),
          )

          const updated = await NoteStore.get(scope.id, existing.id)
          expect(updated.blueprint?.defaultAgent).toBe("developer")
        },
      })
    }))

  test("does not expose or persist a model-selected Blueprint audit agent", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      const scope = (await Scope.fromDirectory(tmp.path)).scope

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const session = await Session.create({})
          await Session.update(session.id, (draft) => {
            draft.workflow = { kind: "lattice", runID: "ltr_test", mode: "auto" }
          })
          const tool = await NoteWriteTool.init()
          const schema = z.toJSONSchema(tool.parameters) as { properties?: Record<string, unknown> }

          expect(schema.properties).not.toHaveProperty("auditAgent")

          const legacyInput = {
            mode: "create",
            noteTitle: "Model-authored Blueprint",
            noteContent: "Execute the current Step.",
            kind: "blueprint",
            auditAgent: "reviewer",
            scope: "current",
          } as unknown as Parameters<typeof tool.execute>[0]
          await expect(tool.execute(legacyInput, ctx(session.id))).rejects.toThrow("invalid arguments")

          const existing = await NoteStore.create({
            title: "Legacy-configured Blueprint",
            content: NoteMarkdown.fromMarkdown("Original"),
            kind: "blueprint",
            blueprint: { auditAgent: "reviewer" },
          })
          await tool.execute(
            {
              mode: "replace",
              noteId: existing.id,
              noteContent: "Updated",
              scope: "current",
            },
            ctx(session.id),
          )

          const updated = await NoteStore.get(scope.id, existing.id)
          expect(updated.blueprint?.auditAgent).toBe("reviewer")
        },
      })
    }))
})

afterRuntimeTests(() => runtime.close())
