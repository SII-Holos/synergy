import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Todo } from "../../src/session/todo"
import { StoragePath } from "../../src/storage/path"
import { Storage } from "../../src/storage/storage"

async function createSessionFixture() {
  const scopeID = Identifier.asScopeID(`scope_${Math.random().toString(36).slice(2)}`)
  const sessionID = Identifier.ascending("session")
  await Storage.write(StoragePath.sessionIndex(sessionID), { scopeID })
  await Storage.write(StoragePath.sessionInfo(scopeID, sessionID), {
    id: sessionID,
    scope: { id: scopeID },
  })
  return { scopeID, sessionID }
}

describe("Todo.get", () => {
  test("returns an empty array when no todo list is persisted", async () => {
    const { sessionID } = await createSessionFixture()
    expect(await Todo.get(sessionID)).toEqual([])
  })

  test("returns the persisted todo list", async () => {
    const { scopeID, sessionID } = await createSessionFixture()
    const todos: Todo.Info[] = [{ id: "todo-1", content: "Do it", status: "completed", priority: "high" }]
    await Storage.write(StoragePath.sessionTodo(scopeID, sessionID), todos)

    expect(await Todo.get(sessionID)).toEqual(todos)
  })
})
