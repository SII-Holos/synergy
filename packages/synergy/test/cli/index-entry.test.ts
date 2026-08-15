import path from "path"

// The default bootstrap branch resolves to the server command, which starts a
// real long-running server (argv has no positional, so main.ts defaults to
// "server"). Swap that module for a no-op so the entry module completes its
// startup lines in-process without binding a port — otherwise the import never
// settles on CI where port 4096 is free, and the suite hangs until the job
// times out.
const runtimeModuleURL = path.resolve(import.meta.dir, "../../src/server/runtime.ts")
mock.module(runtimeModuleURL, () => ({
  run: async () => {},
}))

import { expect, mock, test } from "bun:test"

// Drive src/index.ts's default bootstrap branch in-process. Each Bun test file
// runs in its own worker, so mutating argv and process.exit here cannot leak
// into other suites.
test("index.ts bootstrap reaches the CLI and completes", async () => {
  process.argv = [process.execPath, "synergy"]
  const originalExit = process.exit
  process.exit = ((code?: number) => {
    throw new Error(`exit called: ${code}`)
  }) as never
  const originalLog = console.log
  const logs: string[] = []
  console.log = (...values: unknown[]) => {
    logs.push(values.map(String).join(" "))
  }
  try {
    await expect(import("../../src/index")).resolves.toBeTruthy()
  } catch (error) {
    expect((error as Error).message).toMatch(/^exit called/)
  } finally {
    console.log = originalLog
    process.exit = originalExit
  }
})
