import { expect, test } from "bun:test"

// Drive src/index.ts's default bootstrap branch in-process. Each Bun test file
// runs in its own worker, so mutating argv and process.exit here cannot leak
// into other suites.
test("index.ts bootstrap reaches the CLI and completes", async () => {
  // --help makes yargs print usage and call exitProcess(0) instead of
  // defaulting to the long-running server command (argv without a positional
  // resolves to "server", which binds a real port and never settles on CI).
  // The exit stub records the call instead of throwing: a throw would be
  // caught by main.ts, which sets process.exitCode = 1 and makes the whole
  // test worker exit non-zero despite a passing test.
  process.argv = [process.execPath, "synergy", "--help"]
  const originalExit = process.exit
  const exitCalls: number[] = []
  process.exit = ((code?: number) => {
    exitCalls.push(code ?? 0)
  }) as never
  try {
    await expect(import("../../src/index")).resolves.toBeTruthy()
  } finally {
    process.exit = originalExit
  }
  expect(exitCalls).toEqual([0])
})
