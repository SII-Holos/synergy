import { expect, mock, test } from "bun:test"
import path from "path"

// daemon/entry.ts awaits a real server runtime; swap only the run entry so the
// entry module completes its startup lines in-process. Keep every other export
// (pluginStatusRow, startupScopeLabel, ...) intact: under --shard and in the
// single-process coverage run the mock leaks into sibling test files, and a
// stub that drops named exports breaks their imports.
const runtimeModuleURL = path.resolve(import.meta.dir, "../../src/server/runtime.ts")
const runtimeExports = await import(runtimeModuleURL)
mock.module(runtimeModuleURL, () => ({
  ...runtimeExports,
  run: async () => {},
}))

test("daemon entry completes startup against the isolated test home", async () => {
  process.argv = [process.execPath, "synergy-daemon"]
  const originalExit = process.exit
  process.exit = ((code?: number) => {
    throw new Error(`exit called: ${code}`)
  }) as never
  try {
    await expect(import("../../src/daemon/entry")).resolves.toBeTruthy()
  } catch (error) {
    expect((error as Error).message).toMatch(/^exit called/)
  } finally {
    process.exit = originalExit
  }
})
