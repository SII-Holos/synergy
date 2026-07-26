import { describe, expect, test } from "bun:test"
import {
  DesktopShellEnvironment,
  mergePathValues,
  normalizePathValue,
  parseLoginShellPath,
  resolvePathCommands,
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

  test("captures the login-shell PATH once and reuses the result", async () => {
    let calls = 0
    const environment = new DesktopShellEnvironment({
      env: { PATH: "/usr/bin:/bin", SHELL: "/bin/bash" },
      userShell: "/bin/sh",
      runLoginShell: async (shell, args, env) => {
        calls++
        expect(shell).toBe("/bin/sh")
        expect(args).toEqual(["-ilc", `/bin/sh -c 'printf "\\0SYNERGY_PATH_START\\0%s\\0SYNERGY_PATH_END\\0" "$PATH"'`])
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
