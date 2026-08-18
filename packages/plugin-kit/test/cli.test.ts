import { describe, expect, test } from "bun:test"
import path from "path"
import {
  captureStdout,
  createFixtureProject,
  minimalPluginSource,
  restoreExitCode,
  writeMinimalPlugin,
} from "./fixtures"

const cliPath = path.resolve(import.meta.dir, "../src/cli.ts")

async function runCli(args: string[]) {
  const originalArgv = process.argv
  process.argv = [process.execPath, cliPath, ...args]
  try {
    return await captureStdout(() => import(`../src/cli.ts?probe=${Date.now()}-${Math.random().toString(16).slice(2)}`))
  } finally {
    process.argv = originalArgv
  }
}

describe("synergy-plugin CLI entrypoint wiring", () => {
  test("runs the entry command through yargs in-process and reports failures", async () => {
    const previousExitCode = process.exitCode
    try {
      await runCli(["entry", path.join(import.meta.dir, "cli-entry-missing-", "missing.tgz")])
      expect(process.exitCode).toBe(1)
    } finally {
      restoreExitCode(previousExitCode)
    }
  })

  test("runs the test command through yargs in-process", async () => {
    const previousExitCode = process.exitCode
    try {
      await runCli(["test", path.join(import.meta.dir, "cli-test-missing-")])
      expect(process.exitCode).toBe(1)
    } finally {
      restoreExitCode(previousExitCode)
    }
  })

  test("runs the validate command through yargs in-process", async () => {
    const project = createFixtureProject("cli-validate-")
    try {
      writeMinimalPlugin(project, minimalPluginSource("cli-validate"))
      const previousExitCode = process.exitCode
      try {
        const { output } = await runCli(["validate", project.root])
        expect(output).toContain("PASS")
        expect(process.exitCode ?? 0).toBe(0)
      } finally {
        restoreExitCode(previousExitCode)
      }
    } finally {
      project.cleanup()
    }
  })
})
