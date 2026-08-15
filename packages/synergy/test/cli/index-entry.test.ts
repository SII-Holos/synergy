import { expect, test } from "bun:test"

// Drive src/index.ts's default bootstrap branch in-process. Each Bun test file
// runs in its own worker, so mutating argv and process.exit here cannot leak
// into other suites.
test("index.ts bootstrap reaches the CLI and completes", async () => {
  // --help makes yargs print usage and exitProcess(0) instead of defaulting to
  // the long-running server command (argv without a positional resolves to
  // "server", which binds a real port and never settles on CI). The exit stub
  // below turns that process.exit into a throw the test asserts on.
  process.argv = [process.execPath, "synergy", "--help"]
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
