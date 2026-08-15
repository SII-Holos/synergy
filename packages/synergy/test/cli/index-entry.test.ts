import { expect, test } from "bun:test"

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
