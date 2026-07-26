import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  buildLoginShellInvocation,
  DesktopShellEnvironment,
  mergePathValues,
  normalizePathValue,
  parseLoginShellPath,
  resolvePathCommands,
  runLoginShell,
} from "../src/shell-environment.js"

describe("desktop shell environment", () => {
  test("extracts a framed PATH without importing profile output", () => {
    expect(
      parseLoginShellPath(
        "profile banner\n\0ignored\0\n\0SYNERGY_PATH_START\0/opt/homebrew/bin:/usr/bin\0SYNERGY_PATH_END\0\nprofile footer\0ignored\0",
      ),
    ).toBe("/opt/homebrew/bin:/usr/bin")
    expect(parseLoginShellPath("profile banner only")).toBeNull()
  })

  test("normalizes and merges absolute PATH entries", () => {
    expect(normalizePathValue("/usr/bin::relative:/opt/tools/../bin:/usr/bin:/bad\tpath:\ninvalid")).toBe(
      "/usr/bin:/opt/bin",
    )
    expect(mergePathValues("/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin:/usr/sbin")).toBe(
      "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin",
    )
  })

  test("normalizes Windows PATH entries case-insensitively", () => {
    expect(normalizePathValue("C:\\Tools;C:\\tools;relative;D:\\Apps\\..\\Bin", "win32")).toBe("C:\\Tools;D:\\Bin")
    expect(mergePathValues("C:\\Tools", "C:\\TOOLS;C:\\Windows", "win32")).toBe("C:\\Tools;C:\\Windows")
  })

  test("resolves a fixed command list from the effective PATH", () => {
    const executable = new Set(["/tools/bun", "/usr/bin/git"])
    expect(
      resolvePathCommands("/tools:/usr/bin", ["bun", "git", "gh"], {
        isExecutable: (candidate) => executable.has(candidate),
      }),
    ).toEqual([
      { command: "bun", path: "/tools/bun" },
      { command: "git", path: "/usr/bin/git" },
      { command: "gh", path: null },
    ])
  })

  test("resolves Windows commands through PATHEXT", () => {
    const executable = new Set(["C:\\Tools\\bun.EXE", "C:\\Git\\git.CMD"])
    expect(
      resolvePathCommands("C:\\Tools;C:\\Git", ["bun", "git", "gh"], {
        platform: "win32",
        pathExt: ".EXE;.CMD",
        isExecutable: (candidate) => executable.has(candidate),
      }),
    ).toEqual([
      { command: "bun", path: "C:\\Tools\\bun.EXE" },
      { command: "git", path: "C:\\Git\\git.CMD" },
      { command: "gh", path: null },
    ])
  })

  test("uses a login argv0 with separately parsed interactive command flags", () => {
    expect(buildLoginShellInvocation("/bin/zsh").argv0).toBe("-zsh")
    expect(buildLoginShellInvocation("/bin/zsh").args.slice(0, 2)).toEqual(["-i", "-c"])
    expect(buildLoginShellInvocation("/bin/tcsh").argv0).toBe("-tcsh")
    expect(buildLoginShellInvocation("/bin/tcsh").args.slice(0, 2)).toEqual(["-i", "-c"])
  })

  test.skipIf(process.platform === "win32")("hard kills a login shell that ignores SIGTERM", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "synergy-desktop-login-shell-"))
    const shell = path.join(directory, "ignore-term.sh")
    await writeFile(shell, '#!/bin/sh\ntrap "" TERM\nwhile :; do sleep 1; done\n', { mode: 0o755 })
    const started = Date.now()

    try {
      await expect(runLoginShell(shell, buildLoginShellInvocation(shell), {}, { timeoutMs: 50 })).rejects.toThrow(
        "timed out",
      )
      expect(Date.now() - started).toBeLessThan(1_000)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === "win32")("hard kills a login shell that exceeds the output limit", async () => {
    const invocation = buildLoginShellInvocation("/bin/sh")
    invocation.args = ["-c", "yes x | head -c 1000"]

    await expect(runLoginShell("/bin/sh", invocation, {}, { timeoutMs: 1_000, maxBuffer: 10 })).rejects.toThrow(
      "output exceeded",
    )
  })

  test("captures the login-shell PATH once and reuses the result", async () => {
    let calls = 0
    const environment = new DesktopShellEnvironment({
      env: { PATH: "/usr/bin:/bin", SHELL: "/bin/bash" },
      userShell: "/bin/sh",
      runLoginShell: async (shell, invocation, env) => {
        calls++
        expect(shell).toBe("/bin/sh")
        expect(invocation).toEqual({
          argv0: "-sh",
          args: ["-i", "-c", `/bin/sh -c 'printf "\\0SYNERGY_PATH_START\\0%s\\0SYNERGY_PATH_END\\0" "$PATH"'`],
        })
        expect(env.PATH).toBe("/usr/bin:/bin")
        return "profile output\n\0SYNERGY_PATH_START\0/opt/homebrew/bin:/usr/bin\0SYNERGY_PATH_END\0\nfooter\0ignored\0"
      },
      resolveCommands: (pathValue: string) => [
        { command: "bun", path: pathValue.startsWith("/opt") ? "/opt/bun" : null },
      ],
    })

    const first = await environment.resolve()
    const second = await environment.resolve()

    expect(calls).toBe(1)
    expect(second).toBe(first)
    expect(first).toEqual({
      source: "login-shell",
      shell: "/bin/sh",
      path: "/opt/homebrew/bin:/usr/bin:/bin",
      commands: [{ command: "bun", path: "/opt/bun" }],
      warning: null,
    })
  })

  test("falls back to the inherited PATH when the login shell fails", async () => {
    const environment = new DesktopShellEnvironment({
      env: { PATH: "/usr/bin:/bin", SHELL: "/bin/bash" },
      userShell: "/bin/sh",
      runLoginShell: async () => {
        throw new Error("profile failed with sensitive output")
      },
      resolveCommands: () => [],
    })

    expect(await environment.resolve()).toEqual({
      source: "inherited",
      shell: "/bin/sh",
      path: "/usr/bin:/bin",
      commands: [],
      warning: "login-shell-unavailable",
    })
  })

  test("uses the inherited PATH directly on Windows", async () => {
    let calls = 0
    const environment = new DesktopShellEnvironment({
      env: { PATH: "C:\\Windows\\System32;C:\\Tools" },
      platform: "win32",
      runLoginShell: async () => {
        calls++
        return ""
      },
      resolveCommands: () => [],
    })

    expect(await environment.resolve()).toEqual({
      source: "inherited",
      shell: null,
      path: "C:\\Windows\\System32;C:\\Tools",
      commands: [],
      warning: null,
    })
    expect(calls).toBe(0)
  })
})
