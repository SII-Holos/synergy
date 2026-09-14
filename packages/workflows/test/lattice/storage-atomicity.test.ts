import { expect, spyOn, test } from "bun:test"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { LatticeStore } from "../../src/lattice/store"

test("a failed current pointer cannot publish an orphan active Run", async () => {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  await ScopeContext.provide({
    scope,
    fn: async () => {
      const sessionID = Identifier.ascending("session")
      const pointer = StoragePath.latticeCurrent(Identifier.asScopeID(scope.id), sessionID)
      const write = Storage.write
      const failure = spyOn(Storage, "write").mockImplementation(async (key, value) => {
        if (JSON.stringify(key) === JSON.stringify(pointer)) throw new Error("pointer unavailable")
        return write(key, value)
      })
      try {
        await expect(LatticeStore.create({ sessionID, mode: "auto" })).rejects.toThrow("pointer unavailable")
      } finally {
        failure.mockRestore()
      }
      expect(await LatticeStore.listBySession(scope.id, sessionID)).toEqual([])
    },
  })
})
