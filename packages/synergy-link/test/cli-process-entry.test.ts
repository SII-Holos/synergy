import { describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"

describe("synergy-link cli in-process entry", () => {
  test("renders an offline status snapshot through the full human pipeline", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "synergy-link-cli-process-entry-"))
    const stdoutChunks: string[] = []
    const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      stdoutChunks.push(args.map(String).join(" ") + "\n")
    })

    const originalArgv = [...process.argv]
    const originalExit = process.exit
    const originalHome = process.env.SYNERGY_LINK_HOME
    const originalSynergyHome = process.env.SYNERGY_TEST_HOME
    process.argv = [process.execPath, "src/cli.ts", "status"]
    process.env.SYNERGY_LINK_HOME = path.join(root, "link")
    process.env.SYNERGY_TEST_HOME = path.join(root, "synergy")
    process.env.NO_COLOR = "1"
    let exitCode = 0
    process.exit = ((code?: number) => {
      exitCode = code ?? 0
      throw new Error(`__scenario_exit_${code ?? 0}__`)
    }) as never

    try {
      await import("../src/cli.ts")
    } catch (error) {
      if (!String(error).includes("__scenario_exit_")) throw error
    } finally {
      process.argv = originalArgv
      process.exit = originalExit
      if (originalHome === undefined) delete process.env.SYNERGY_LINK_HOME
      else process.env.SYNERGY_LINK_HOME = originalHome
      if (originalSynergyHome === undefined) delete process.env.SYNERGY_TEST_HOME
      else process.env.SYNERGY_TEST_HOME = originalSynergyHome
      logSpy.mockRestore()
    }

    expect(exitCode).toBe(1)
    const output = stdoutChunks.join("")
    expect(output).toContain("snapshot (last-known)")
    expect(output).toContain("Mode")
    expect(output).toContain("Service")
    expect(output).toContain("stopped")
    await rm(root, { recursive: true, force: true })
  })
})
