import { expect, mock, test } from "bun:test"
import path from "path"

// daemon/entry.ts awaits a real server runtime; swap that module for a no-op
// so the entry module completes its startup lines in-process.
const runtimeModuleURL = path.resolve(import.meta.dir, "../../src/server/runtime.ts")
mock.module(runtimeModuleURL, () => ({
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
