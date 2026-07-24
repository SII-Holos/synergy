import { afterEach, describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Shell } from "../../src/util/shell"

const ORIGINAL_SHELL = process.env.SHELL

function expectedFallback() {
  if (process.platform === "win32") {
    const git = Bun.which("git")
    if (git) {
      const bash = path.join(git, "..", "..", "bin", "bash.exe")
      if (Bun.file(bash).size) return bash
    }
    return process.env.COMSPEC || "cmd.exe"
  }
  if (process.platform === "darwin") {
    for (const shell of ["/bin/zsh", "/bin/bash", "/bin/sh"]) {
      if (Bun.file(shell).size) return shell
    }
    return "/bin/sh"
  }
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
  test("waits for successful Windows taskkill completion", async () => {
    let alive = true
    const directSignals: Array<NodeJS.Signals | number | undefined> = []
    const killer = new EventEmitter() as EventEmitter & { kill: () => boolean }
    killer.kill = () => true
    const child = {
      pid: 123,
      kill: (signal?: NodeJS.Signals | number) => {
        directSignals.push(signal)
        alive = false
        return true
      },
    } as ChildProcess
    const runtime: Shell.KillTreeRuntimeForTest = {
      platform: "win32",
      taskkill: (pid) => {
        expect(pid).toBe(123)
        queueMicrotask(() => {
          alive = false
          killer.emit("exit", 0)
        })
        return killer
      },
      isPidAlive: () => alive,
      taskkillTimeoutMs: 10,
    }

    await Shell.killTree(child, { runtime })

    expect(directSignals).toEqual([])
  })
  test("falls back when successful Windows taskkill leaves the process alive", async () => {
    const directSignals: Array<NodeJS.Signals | number | undefined> = []
    const killer = new EventEmitter() as EventEmitter & { kill: () => boolean }
    killer.kill = () => true
    const child = {
      pid: 234,
      kill: (signal?: NodeJS.Signals | number) => {
        directSignals.push(signal)
        return true
      },
    } as ChildProcess
    const runtime: Shell.KillTreeRuntimeForTest = {
      platform: "win32",
      taskkill: () => {
        queueMicrotask(() => killer.emit("exit", 0))
        return killer
      },
      isPidAlive: () => true,
      taskkillTimeoutMs: 10,
    }

    await Shell.killTree(child, { runtime })

    expect(directSignals).toEqual(["SIGKILL"])
  })

  test("falls back to direct kill when Windows taskkill fails", async () => {
    let alive = true
    const directSignals: Array<NodeJS.Signals | number | undefined> = []
    const killer = new EventEmitter() as EventEmitter & { kill: () => boolean }
    killer.kill = () => true
    const child = {
      pid: 456,
      kill: (signal?: NodeJS.Signals | number) => {
        directSignals.push(signal)
        alive = false
        return true
      },
    } as ChildProcess
    const runtime: Shell.KillTreeRuntimeForTest = {
      platform: "win32",
      taskkill: () => {
        queueMicrotask(() => killer.emit("exit", 1))
        return killer
      },
      isPidAlive: () => alive,
      taskkillTimeoutMs: 10,
    }

    await Shell.killTree(child, { runtime })

    expect(directSignals).toEqual(["SIGKILL"])
    expect(alive).toBe(false)
  })
  test("does not target a reused Windows PID after the direct parent exits", async () => {
    let taskkillCalls = 0
    const directSignals: Array<NodeJS.Signals | number | undefined> = []
    const killer = new EventEmitter() as EventEmitter & { kill: () => boolean }
    killer.kill = () => true
    const child = {
      pid: 457,
      kill: (signal?: NodeJS.Signals | number) => {
        directSignals.push(signal)
        return true
      },
    } as ChildProcess
    const runtime: Shell.KillTreeRuntimeForTest = {
      platform: "win32",
      taskkill: () => {
        taskkillCalls++
        return killer
      },
      isPidAlive: () => true,
      taskkillTimeoutMs: 10,
    }

    await Shell.killTree(child, {
      exited: () => true,
      allowExitedParent: true,
      runtime,
    })

    expect(taskkillCalls).toBe(0)
    expect(directSignals).toEqual([])
  })
  test("does not fall back to a reusable Unix parent PID after the owned group disappears", async () => {
    const groupSignals: Array<NodeJS.Signals | number> = []
    const directSignals: Array<NodeJS.Signals | number | undefined> = []
    const child = {
      pid: 987_654,
      kill: (signal?: NodeJS.Signals | number) => {
        directSignals.push(signal)
        return true
      },
    } as ChildProcess
    const runtime = {
      platform: "darwin",
      signalProcessGroup(_pid: number, signal: NodeJS.Signals | number) {
        groupSignals.push(signal)
        throw Object.assign(new Error("missing process group"), { code: "ESRCH" })
      },
      taskkill: () => {
        throw new Error("unexpected taskkill")
      },
      isPidAlive: () => false,
      taskkillTimeoutMs: 10,
    } as Shell.KillTreeRuntimeForTest

    await Shell.killTree(child, {
      exited: () => true,
      allowExitedParent: true,
      runtime,
    })

    expect(groupSignals).toEqual(["SIGTERM"])
    expect(directSignals).toEqual([])
  })
  test.skipIf(process.platform === "win32")("anchors an exited shell process group until release", async () => {
    const invocation = Shell.prepareOwnedProcessGroup({ command: "/bin/sh", args: ["-c", "exit 7"] })
    const child = Bun.spawn([invocation.command, ...invocation.args], {
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    const pid = child.pid

    expect(await child.exited).toBe(7)
    expect(() => process.kill(-pid, 0)).not.toThrow()

    Shell.releaseOwnedProcessGroup({ pid } as ChildProcess)
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        process.kill(-pid, 0)
        await Bun.sleep(10)
      } catch {
        return
      }
    }
    throw new Error("owned process-group anchor remained alive after release")
  })

  test("does not reject when Windows fallback kill throws", async () => {
    const killer = new EventEmitter() as EventEmitter & { kill: () => boolean }
    killer.kill = () => true
    const child = {
      pid: 567,
      kill: () => {
        throw new Error("process already exited")
      },
    } as unknown as ChildProcess
    const runtime: Shell.KillTreeRuntimeForTest = {
      platform: "win32",
      taskkill: () => {
        queueMicrotask(() => killer.emit("exit", 1))
        return killer
      },
      isPidAlive: () => true,
      taskkillTimeoutMs: 10,
    }

    await expect(Shell.killTree(child, { runtime })).resolves.toBeUndefined()
  })

  test("bounds a hung Windows taskkill before direct fallback", async () => {
    let taskkillKills = 0
    let directKills = 0
    const killer = new EventEmitter() as EventEmitter & { kill: () => boolean }
    killer.kill = () => {
      taskkillKills++
      return true
    }
    const child = {
      pid: 789,
      kill: () => {
        directKills++
        return true
      },
    } as ChildProcess
    const runtime: Shell.KillTreeRuntimeForTest = {
      platform: "win32",
      taskkill: () => killer,
      isPidAlive: () => true,
      taskkillTimeoutMs: 1,
    }

    await Shell.killTree(child, { runtime })

    expect(taskkillKills).toBe(1)
    expect(directKills).toBe(1)
  })
})
