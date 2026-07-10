import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { Session } from "../../src/session"
import { NoteStore } from "../../src/note"

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn })
}

describe("session charter binding", () => {
  test("a session can be bound to and cleared of a charter note", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      const note = await NoteStore.create({
        title: "Employee handbook",
        content: "Follow the process.",
        kind: "charter",
      })
      const session = await Session.create({})

      const bound = await Session.update(session.id, (draft) => {
        draft.charter = { noteID: note.id }
      })
      expect(bound.charter?.noteID).toBe(note.id)

      const cleared = await Session.update(session.id, (draft) => {
        draft.charter = undefined
      })
      expect(cleared.charter).toBeUndefined()
    })
  })

  test("charter notes are stored with kind 'charter'", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      const note = await NoteStore.create({ title: "Charter", content: "x", kind: "charter" })
      const fetched = await NoteStore.getAny(scopeID, note.id)
      expect(fetched.kind).toBe("charter")
    })
  })
})
