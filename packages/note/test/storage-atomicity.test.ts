import { expect, spyOn, test } from "bun:test"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { NoteStore } from "../src"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "./support/runtime"
const runtime = await testRuntime()

test("a failed global promotion preserves the original Note and both indexes", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const note = await NoteStore.create({ title: "Original" })
        const original = Storage.write
        const write = spyOn(Storage, "write").mockImplementation(async (key, value) => {
          if (key[0] === "notes" && key[1] === "home" && key[2] === "_index") throw new Error("index unavailable")
          return original(key, value)
        })
        try {
          await expect(NoteStore.update(scope.id, note.id, { global: true })).rejects.toThrow("index unavailable")
        } finally {
          write.mockRestore()
        }
        expect(await NoteStore.get(scope.id, note.id)).toEqual(note)
        await expect(NoteStore.get("home", note.id)).rejects.toBeInstanceOf(Storage.NotFoundError)
        expect((await NoteStore.listMeta(scope.id)).some((entry) => entry.id === note.id)).toBe(true)
      },
    })
  }))

afterRuntimeTests(() => runtime.close())
