import { describe, expect, test } from "bun:test"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Identifier } from "../../src/id/id"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { CharterStore } from "../../src/workflow-run/charter-store"
import { WorkflowTypes } from "../../src/workflow-run/types"
import { tmpdir } from "../fixture/fixture"

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn })
}

function input(name: string): CharterStore.CreateInput {
  return {
    id: "cht_atomic",
    name,
    entityType: "task",
    entityInitialState: "queued",
    states: ["queued", "done", WorkflowTypes.BLOCKED_STATE],
    terminalStates: ["done"],
    seats: [
      {
        name: "worker",
        agent: "synergy",
        interaction: "unattended",
        pool: 1,
        worktree: "none",
      },
    ],
    transitions: [],
  }
}

describe("CharterStore immutability", () => {
  test("concurrent creates allocate distinct versions", async () => {
    await withScope(async () => {
      const created = await Promise.all([CharterStore.create(input("A")), CharterStore.create(input("B"))])
      expect(created.map((charter) => charter.version).sort()).toEqual([1, 2])
      expect(await CharterStore.latestVersion(ScopeContext.current.scope.id, "cht_atomic")).toBe(2)
    })
  })

  test("put is idempotent but cannot overwrite an immutable version", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      const charter = WorkflowTypes.Charter.parse({
        ...input("A"),
        version: 1,
        budget: { maxModelCalls: 0 },
        gates: [],
        time: { created: 1 },
      })
      await CharterStore.put(scopeID, charter)
      await expect(CharterStore.put(scopeID, { ...charter, name: "changed" })).rejects.toThrow(
        /WorkflowCharterConflict/,
      )
      expect((await CharterStore.get(scopeID, charter.id, 1)).name).toBe("A")
    })
  })

  test("getOrUndefined only suppresses a missing charter, not corrupted state", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      expect(await CharterStore.getOrUndefined(scopeID, "cht_missing")).toBeUndefined()

      await Storage.write(StoragePath.charter(Identifier.asScopeID(scopeID), "cht_corrupt", 1), { corrupt: true })
      await expect(CharterStore.getOrUndefined(scopeID, "cht_corrupt", 1)).rejects.toThrow()
    })
  })
})
