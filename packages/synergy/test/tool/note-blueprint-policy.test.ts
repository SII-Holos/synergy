import { describe, expect, test } from "bun:test"
import { NoteDocument, NoteMarkdown, NoteStore } from "../../src/note"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { NoteEditTool } from "../../src/tool/note-edit"
import { NoteWriteTool } from "../../src/tool/note-write"
import type { Tool } from "../../src/tool/tool"
import { tmpdir } from "../fixture/fixture"

function ctx(sessionID: string): Tool.Context {
  return {
    sessionID,
    messageID: "message_test",
    agent: "synergy",
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  }
}

async function createSession(input?: { planMode?: boolean }) {
  const session = await Session.create({})
  if (input?.planMode) {
    await Session.update(session.id, (draft) => {
      draft.blueprint = { planMode: true }
    })
  }
  return session
}

function anchoredReplace(
  note: Awaited<ReturnType<typeof NoteStore.get>> | Awaited<ReturnType<typeof NoteStore.create>>,
  text: string,
) {
  const block = NoteDocument.listBlocks(note.content)[0]
  return {
    id: note.id,
    baseVersion: note.version,
    baseDocHash: NoteDocument.hash(note.content),
    freshen: "safe" as const,
    dryRun: false,
    ops: [
      {
        action: "replaceBlock" as const,
        blockId: block.id,
        expectedHash: block.hash,
        content: { format: "text" as const, text },
      },
    ],
  }
}

describe("note Blueprint write policy", () => {
  test("blocks Blueprint creation outside Plan Mode while allowing ordinary notes", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await createSession()
        const write = await NoteWriteTool.init()

        const blocked = await write.execute(
          {
            mode: "create",
            title: "Accidental Blueprint",
            content: "deliverable",
            kind: "blueprint",
            scope: "current",
          },
          ctx(session.id),
        )

        expect(blocked.metadata.reason).toBe("non_plan_mode_blueprint_write")
        expect(blocked.output).toContain("not in Plan Mode")
        expect(await NoteStore.list(ScopeContext.current.scope.id)).toHaveLength(0)

        const implicitByDescription = await write.execute(
          {
            mode: "create",
            title: "Implicit Blueprint",
            content: "deliverable",
            description: "Executable plan",
            scope: "current",
          },
          ctx(session.id),
        )
        expect(implicitByDescription.metadata.reason).toBe("non_plan_mode_blueprint_write")

        const implicitByDefaultAgent = await write.execute(
          {
            mode: "create",
            title: "Implicit Agent Blueprint",
            content: "deliverable",
            defaultAgent: "synergy-max",
            scope: "current",
          },
          ctx(session.id),
        )
        expect(implicitByDefaultAgent.metadata.reason).toBe("non_plan_mode_blueprint_write")
        expect(await NoteStore.list(ScopeContext.current.scope.id)).toHaveLength(0)

        const created = await write.execute(
          {
            mode: "create",
            title: "Ordinary Deliverable",
            content: "deliverable",
            kind: "note",
            scope: "current",
          },
          ctx(session.id),
        )

        expect(created.metadata.kind).toBe("note")
        const noteID = created.metadata.id as string

        const updated = await write.execute(
          {
            mode: "replace",
            id: noteID,
            content: "updated deliverable",
            scope: "current",
          },
          ctx(session.id),
        )
        expect(updated.metadata.kind).toBe("note")

        const edit = await NoteEditTool.init()
        const editable = await NoteStore.get(ScopeContext.current.scope.id, noteID)
        const edited = await edit.execute(anchoredReplace(editable, "edited deliverable"), ctx(session.id))
        expect(edited.output).toContain("Note edited successfully")

        const convertBlocked = await write.execute(
          {
            mode: "replace",
            id: noteID,
            content: "converted deliverable",
            kind: "blueprint",
            scope: "current",
          },
          ctx(session.id),
        )
        expect(convertBlocked.metadata.reason).toBe("non_plan_mode_blueprint_write")

        const implicitConvertBlocked = await write.execute(
          {
            mode: "replace",
            id: noteID,
            content: "converted deliverable",
            description: "Executable plan",
            scope: "current",
          },
          ctx(session.id),
        )
        expect(implicitConvertBlocked.metadata.reason).toBe("non_plan_mode_blueprint_write")

        expect(await NoteStore.list(ScopeContext.current.scope.id)).toHaveLength(1)
        const stored = await NoteStore.get(ScopeContext.current.scope.id, noteID)
        expect(stored.kind).toBe("note")
        expect(NoteMarkdown.toMarkdown(stored.content).trim()).toBe("edited deliverable")
      },
    })
  })

  test("blocks updating and editing existing Blueprints outside Plan Mode", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await createSession()
        const blueprint = await NoteStore.create({
          title: "Existing Blueprint",
          content: NoteMarkdown.fromMarkdown("Original"),
          kind: "blueprint",
          blueprint: { description: "Test Blueprint" },
        })
        const write = await NoteWriteTool.init()
        const edit = await NoteEditTool.init()

        const writeBlocked = await write.execute(
          {
            mode: "replace",
            id: blueprint.id,
            content: "Updated",
            scope: "current",
          },
          ctx(session.id),
        )
        expect(writeBlocked.metadata.reason).toBe("non_plan_mode_blueprint_write")
        expect(writeBlocked.output).toContain("Blueprint notes are read-only")

        const appendBlocked = await write.execute(
          {
            mode: "append",
            id: blueprint.id,
            content: "Appended",
            scope: "current",
          },
          ctx(session.id),
        )
        expect(appendBlocked.metadata.reason).toBe("non_plan_mode_blueprint_write")

        const editBlocked = await edit.execute(anchoredReplace(blueprint, "Edited"), ctx(session.id))
        expect(editBlocked.metadata.reason).toBe("non_plan_mode_blueprint_write")

        const stored = await NoteStore.get(ScopeContext.current.scope.id, blueprint.id)
        expect(NoteMarkdown.toMarkdown(stored.content).trim()).toBe("Original")
      },
    })
  })

  test("allows Blueprint creation and edits in Plan Mode", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await createSession({ planMode: true })
        const write = await NoteWriteTool.init()
        const edit = await NoteEditTool.init()

        const created = await write.execute(
          {
            mode: "create",
            title: "Plan Blueprint",
            content: "Initial",
            kind: "blueprint",
            scope: "current",
          },
          ctx(session.id),
        )
        expect(created.metadata.kind).toBe("blueprint")

        const id = created.metadata.id as string
        const replaced = await write.execute(
          {
            mode: "replace",
            id,
            content: "Replaced",
            scope: "current",
          },
          ctx(session.id),
        )
        expect(replaced.output).toContain("Blueprint updated successfully")

        const edited = await edit.execute(
          anchoredReplace(await NoteStore.get(ScopeContext.current.scope.id, id), "Edited"),
          ctx(session.id),
        )
        expect(edited.output).toContain("Note edited successfully")

        const stored = await NoteStore.get(ScopeContext.current.scope.id, id)
        expect(stored.kind).toBe("blueprint")
        expect(NoteMarkdown.toMarkdown(stored.content).trim()).toBe("Edited")
      },
    })
  })
})
