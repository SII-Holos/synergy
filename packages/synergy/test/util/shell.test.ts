import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Shell } from "../../src/util/shell"

const ORIGINAL_SHELL = process.env.SHELL

function expectedFallback() {
  if (process.platform === "win32") return process.env.COMSPEC || "cmd.exe"
  if (process.platform === "darwin") return "/bin/zsh"
  return Bun.which("bash") || "/bin/sh"
}

function resetShell() {
  Shell.preferred.reset()
  Shell.acceptable.reset()
  if (ORIGINAL_SHELL === undefined) delete process.env.SHELL
  else process.env.SHELL = ORIGINAL_SHELL
}

afterEach(() => {
  resetShell()
})

describe("util.shell", () => {
  test("preferred uses SHELL when it exists", async () => {
    await using tmp = await tmpdir()
    const shell = path.join(tmp.path, "custom-shell")
    await Bun.write(shell, "")
    if (process.platform !== "win32") await Bun.$`chmod +x ${shell}`
    process.env.SHELL = shell
    Shell.preferred.reset()

    expect(Shell.preferred()).toBe(shell)
  })

  test("preferred falls back when SHELL path does not exist", () => {
    process.env.SHELL = "/definitely/missing/shell"
    Shell.preferred.reset()

    expect(Shell.preferred()).toBe(expectedFallback())
  })

  test("acceptable falls back when SHELL is blacklisted", async () => {
    await using tmp = await tmpdir()
    const fish = path.join(tmp.path, process.platform === "win32" ? "fish.exe" : "fish")
    await Bun.write(fish, "")
    if (process.platform !== "win32") await Bun.$`chmod +x ${fish}`
    process.env.SHELL = fish
    Shell.acceptable.reset()

    expect(Shell.acceptable()).toBe(expectedFallback())
  })

  test("acceptable falls back when SHELL path does not exist", () => {
    process.env.SHELL = "/definitely/missing/fish"
    Shell.acceptable.reset()

    expect(Shell.acceptable()).toBe(expectedFallback())
  })
})
