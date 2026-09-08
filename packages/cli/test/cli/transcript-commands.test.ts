import { expect, test } from "bun:test"
import yargs from "yargs"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { ExportCommand } from "../../src/cli/cmd/export"
import { ImportCommand } from "../../src/cli/cmd/import"

const invoke = async (args: string[]) =>
  yargs(args).exitProcess(false).command(ExportCommand).command(ImportCommand).parseAsync()

test("CLI exports and imports real session files and reports invalid input without losing the original", async () => {
  await using tmp = await tmpdir({ git: true })
  const cwd = process.cwd()
  const exitCode = process.exitCode
  const stdout = process.stdout.write
  const stderr = process.stderr.write
  const output: string[] = []
  const errors: string[] = []
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output.push(String(chunk))
    return true
  }) as typeof stdout
  process.stderr.write = ((chunk: string | Uint8Array) => {
    errors.push(String(chunk))
    return true
  }) as typeof stderr
  try {
    process.chdir(tmp.path)
    const scope = await tmp.scope()
    const session = await ScopeContext.provide({
      scope,
      fn: () => Session.create({ title: "Independent research transcript" }),
    })
    const json = path.join(tmp.path, "transcript.json")
    await invoke(["export", session.id, "--output", json])
    const report = await Bun.file(json).json()
    expect(report.rootSessionID).toBe(session.id)
    expect(report.sessions).toHaveLength(1)
    output.length = 0
    await invoke(["export", session.id])
    expect(JSON.parse(output.join("")).rootSessionID).toBe(session.id)
    output.length = 0
    await invoke(["import", json])
    expect(output.join("")).toContain("(1 session, 0 messages)")
    const zip = path.join(tmp.path, "transcript.zip")
    await invoke(["export", session.id, "--format", "rollout", "--output", zip])
    expect(new Uint8Array(await Bun.file(zip).arrayBuffer()).slice(0, 2)).toEqual(new Uint8Array([80, 75]))
    output.length = 0
    await invoke(["import", zip])
    expect(output.join("")).toContain("Imported session:")
    const broken = path.join(tmp.path, "broken.json")
    await Bun.write(broken, "not valid json")
    await invoke(["import", broken])
    expect(process.exitCode).toBe(1)
    expect(errors.join("")).toContain("Import failed:")
    await expect(invoke(["import", path.join(tmp.path, "missing.json")])).rejects.toThrow("File not found:")
    await expect(invoke(["export", session.id, "--format", "rollout"])).rejects.toThrow(
      "Rollout export requires --output",
    )
    await expect(invoke(["export", session.id, "--run", "run_unused"])).rejects.toThrow(
      "--run requires --format rollout",
    )
    await ScopeContext.provide({
      scope,
      fn: async () => {
        expect((await Session.get(session.id)).title).toBe("Independent research transcript")
        expect((await Session.list()).total).toBe(3)
      },
    })
  } finally {
    process.chdir(cwd)
    process.exitCode = exitCode ?? 0
    process.stdout.write = stdout
    process.stderr.write = stderr
  }
}, 30000)
