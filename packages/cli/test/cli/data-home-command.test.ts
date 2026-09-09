import { expect, mock, test } from "bun:test"
import path from "node:path"
import yargs from "yargs"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Global } from "@ericsanchezok/synergy-harness/global"

const messages: string[] = []
const capture = (message: string) => messages.push(message)
mock.module(import.meta.resolve("@clack/prompts"), () => ({
  intro: capture,
  outro: capture,
  log: { info: capture, warn: capture, success: capture },
}))
const { DataSetHomeCommand } = await import("../../src/cli/cmd/data/set-home")
const { DataPathCommand } = await import("../../src/cli/cmd/data/path")
const invoke = async (args: string[]) =>
  yargs(args).exitProcess(false).command(DataSetHomeCommand).command(DataPathCommand).parseAsync()

test("data home command changes an isolated shell profile while preserving current data", async () => {
  await using tmp = await tmpdir()
  const shell = process.env.SHELL
  const xdg = process.env.XDG_CONFIG_HOME
  process.env.SHELL = "/usr/bin/fish"
  process.env.XDG_CONFIG_HOME = path.join(tmp.path, "config")
  const profile = path.join(process.env.XDG_CONFIG_HOME, "fish/config.fish")
  const target = path.join(tmp.path, "new-home")
  try {
    await Bun.write(profile, "set fish_greeting off\n")
    await Bun.write(path.join(Global.Path.root, "data/home-command-evidence.json"), "original")
    await invoke(["set-home", target])
    expect(await Bun.file(profile).text()).toContain(`set -gx SYNERGY_HOME "${target}"`)
    expect(await Bun.file(path.join(Global.Path.root, "data/home-command-evidence.json")).text()).toBe("original")
    expect(messages.join("\n")).toContain("will not be moved")
    await Bun.write(path.join(target, ".synergy/data/existing.json"), "preserved")
    await invoke(["set-home", target])
    expect(messages.join("\n")).toContain("Found existing data")
    expect(messages.join("\n")).toContain("already set")
    await invoke(["set-home", target, "--unset"])
    expect(await Bun.file(profile).text()).toBe("set fish_greeting off\n")
    await invoke(["set-home", target, "--unset"])
    expect(messages.join("\n")).toContain("not set in any shell profile")
    await invoke(["path"])
    expect(messages.join("\n")).toContain("Location:")
    expect(await Bun.file(path.join(target, ".synergy/data/existing.json")).text()).toBe("preserved")
  } finally {
    if (shell === undefined) delete process.env.SHELL
    else process.env.SHELL = shell
    if (xdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = xdg
  }
})
