import { expect, test } from "bun:test"
import { WorkspaceFileImport } from "../../src/workspace/file-import"
import { testRuntime } from "../support/runtime"

test("file-import capability belongs to one Runtime and cannot leak into an unconfigured Runtime", async () => {
  const imported: string[] = []
  await using native = await testRuntime({
    register() {
      WorkspaceFileImport.register({
        async importEntry(input, signal) {
          signal?.throwIfAborted()
          await input.validateSource(input.from)
          imported.push(input.to)
        },
      })
    },
  })
  await using absent = await testRuntime()
  const input = { from: "owned-source", to: "destination", validateSource: async () => {} }
  await Promise.all([
    native.run(() => WorkspaceFileImport.apply(input)),
    absent.run(async () => {
      await expect(WorkspaceFileImport.apply(input)).rejects.toThrow("cannot import local files")
      expect(() => WorkspaceFileImport.register({ importEntry: async () => {} })).toThrow()
    }),
  ])
  await native.run(async () => {
    const aborted = AbortSignal.abort()
    await expect(WorkspaceFileImport.apply(input, aborted)).rejects.toMatchObject({ name: "AbortError" })
  })
  expect(imported).toEqual(["destination"])
})
