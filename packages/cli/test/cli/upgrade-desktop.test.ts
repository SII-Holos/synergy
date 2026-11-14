import { describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import * as prompts from "@clack/prompts"
import { UI } from "@ericsanchezok/synergy-util/terminal"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { UpgradeCommand } from "../../src/cli/cmd/upgrade"
import { Installation } from "@ericsanchezok/synergy-harness/global/installation"

describe("desktop-managed upgrade", () => {
  test("does not execute package-manager upgrades", async () => {
    const err = await Installation.upgrade("desktop", "999.0.0").catch((error) => error)

    expect(err).toBeInstanceOf(Installation.DesktopManagedUpdateError)
    expect(err.data.message).toContain("Synergy is installed with the Desktop app")
    expect(err.data.message).toContain("Desktop updates are managed from the Synergy app")
  })
})

test("the actual upgrade handler delegates an inspected Desktop installation and rejects a missing method before any updater", async () => {
  await using directory = await tmpdir()
  const executable = path.join(directory.path, "Synergy.app/Contents/Resources/synergy/bin/synergy")
  await fs.mkdir(path.dirname(executable), { recursive: true })
  await Bun.write(executable, 'console.log("1.2.3")\n')
  const inspect = Installation.inspect
  const calls: string[][] = []
  const versionOutput: string[] = []
  using inspection = spyOn(Installation, "inspect").mockImplementation(() =>
    inspect({
      context: { platform: "darwin", execPath: executable, realExecPath: executable, home: directory.path, env: {} },
      dependencies: {
        exists: async (file) => file === executable && (await Bun.file(file).exists()),
        pathCandidates: async () => [{ path: executable, realPath: executable, isCurrent: true }],
        async run(command) {
          calls.push(command)
          if (command[0] !== executable) return { exitCode: 1, stdout: "", stderr: "" }
          const child = Bun.spawn([process.execPath, executable, ...command.slice(1)], {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          })
          const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ])
          versionOutput.push(stdout.trim())
          return { exitCode, stdout, stderr }
        },
      },
    }),
  )
  using upgrade = spyOn(Installation, "upgrade").mockImplementation(async () => {
    throw new Error("A Desktop handler must not start a package updater")
  })
  using latest = spyOn(Installation, "latest").mockImplementation(async () => {
    throw new Error("Desktop delegates version selection to its app")
  })
  using empty = spyOn(UI, "empty").mockImplementation(() => {})
  using println = spyOn(UI, "println").mockImplementation(() => {})
  using intro = spyOn(prompts, "intro").mockImplementation(() => {})
  using outro = spyOn(prompts, "outro").mockImplementation(() => {})
  using info = spyOn(prompts.log, "info").mockImplementation(() => {})
  using failure = spyOn(prompts.log, "error").mockImplementation(() => {})
  const exitCode = process.exitCode ?? 0
  try {
    process.exitCode = 0
    await UpgradeCommand.handler({ target: "v999.0.0" })
    expect(process.exitCode).toBe(0)
    expect(info.mock.calls.flat().join("\n")).toContain("Settings → Updates")
    expect(calls.filter((command) => command[0] === executable)).toEqual([[executable, "--version"]])
    expect(versionOutput).toEqual(["1.2.3"])
    await UpgradeCommand.handler({ method: "npm", target: "v999.0.0" })
    expect(process.exitCode).toBe(1)
    expect(failure.mock.calls.flat().join("\n")).toContain("Installation method 'npm' was not found")
    expect(upgrade).not.toHaveBeenCalled()
    expect(latest).not.toHaveBeenCalled()
    expect(versionOutput).toEqual(["1.2.3", "1.2.3"])
  } finally {
    process.exitCode = exitCode
  }
})
