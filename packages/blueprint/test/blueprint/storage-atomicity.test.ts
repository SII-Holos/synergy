import { expect, spyOn, test } from "bun:test"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { NoteStore } from "@ericsanchezok/synergy-note"
import { BlueprintLoopStore } from "../../src/blueprint/loop-store"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

test("Blueprint creation rolls back when the Note projection cannot commit", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const note = await NoteStore.create({ title: "atomic blueprint", kind: "blueprint" })
        const write = Storage.write
        using failure = spyOn(Storage, "write").mockImplementation(async (key, value) => {
          if (key[0] === "notes" && key.at(-1) === "_index") throw new Error("projection failed")
          return write(key, value)
        })
        await expect(
          BlueprintLoopStore.create({ noteID: note.id, title: "run", sessionID: "ses_test" }),
        ).rejects.toThrow("projection failed")
        expect(await BlueprintLoopStore.list(scope.id)).toEqual([])
        expect((await NoteStore.get(scope.id, note.id)).blueprint?.activeLoopID).toBeUndefined()
      },
    })
  }))

afterRuntimeTests(() => runtime.close())
