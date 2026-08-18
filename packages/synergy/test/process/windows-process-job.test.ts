import { describe, expect, test } from "bun:test"
import type { ChildProcess } from "node:child_process"
import { WindowsProcessJob } from "../../src/process/windows-process-job"

describe("WindowsProcessJob", () => {
  test("assigns the child before exposing the job owner", () => {
    const calls: string[] = []
    const runtime: WindowsProcessJob.RuntimeForTest = {
      createJob() {
        calls.push("create-job")
        return 1
      },
      configureJob(_job, information) {
        calls.push(`configure-job:${information.byteLength}`)
        expect(new DataView(information.buffer).getUint32(16, true)).toBe(0x00002000)
        return true
      },
      openProcess(pid) {
        calls.push(`open-process:${pid}`)
        return 2
      },
      assignProcess() {
        calls.push("assign-process")
        return true
      },
      terminateJob() {
        calls.push("terminate-job")
        return true
      },
      closeHandle(handle) {
        calls.push(`close:${handle}`)
        return true
      },
      lastError() {
        return 0
      },
    }

    const owner = WindowsProcessJob.attachForTest(42, runtime)
    const informationBytes = process.arch === "ia32" ? 112 : 144
    expect(calls).toEqual([
      "create-job",
      `configure-job:${informationBytes}`,
      "open-process:42",
      "assign-process",
      "close:2",
    ])

    owner.terminate()
    owner.release()
    expect(calls).toEqual([
      "create-job",
      `configure-job:${informationBytes}`,
      "open-process:42",
      "assign-process",
      "close:2",
      "terminate-job",
      "close:1",
    ])
  })

  test("fails closed when job configuration fails", () => {
    const calls: string[] = []
    const runtime: WindowsProcessJob.RuntimeForTest = {
      createJob: () => 1,
      configureJob() {
        calls.push("configure-job")
        return false
      },
      openProcess() {
        calls.push("open-process")
        return 2
      },
      assignProcess: () => true,
      terminateJob: () => true,
      closeHandle(handle) {
        calls.push(`close:${handle}`)
        return true
      },
      lastError: () => 87,
    }

    expect(() => WindowsProcessJob.attachForTest(42, runtime)).toThrow("SetInformationJobObject failed: 87")
    expect(calls).toEqual(["configure-job", "close:1"])
  })

  test("fails closed and releases handles when assignment fails", () => {
    const closed: number[] = []
    const runtime: WindowsProcessJob.RuntimeForTest = {
      createJob: () => 1,
      configureJob: () => true,
      openProcess: () => 2,
      assignProcess: () => false,
      terminateJob: () => true,
      closeHandle(handle) {
        closed.push(handle)
        return true
      },
      lastError: () => 5,
    }

    expect(() => WindowsProcessJob.attachForTest(42, runtime)).toThrow("AssignProcessToJobObject failed: 5")
    expect(closed).toEqual([2, 1])
  })

  test("retains the job handle when termination fails so the caller can retry", () => {
    const calls: string[] = []
    let terminationAttempts = 0
    const runtime: WindowsProcessJob.RuntimeForTest = {
      createJob: () => 1,
      configureJob: () => true,
      openProcess: () => 2,
      assignProcess: () => true,
      terminateJob() {
        terminationAttempts++
        calls.push(`terminate:${terminationAttempts}`)
        return terminationAttempts > 1
      },
      closeHandle(handle) {
        calls.push(`close:${handle}`)
        return true
      },
      lastError: () => 5,
    }
    const owner = WindowsProcessJob.attachForTest(42, runtime)
    calls.length = 0

    expect(() => owner.terminate()).toThrow("TerminateJobObject failed: 5")
    expect(calls).toEqual(["terminate:1"])

    owner.terminate()
    expect(calls).toEqual(["terminate:1", "terminate:2", "close:1"])
  })

  test("falls back to kill-on-close and retains ownership when both operations fail", () => {
    const calls: string[] = []
    let closeAttempts = 0
    const runtime: WindowsProcessJob.RuntimeForTest = {
      createJob: () => 1,
      configureJob: () => true,
      openProcess: () => 2,
      assignProcess: () => true,
      terminateJob() {
        calls.push("terminate")
        return false
      },
      closeHandle(handle) {
        calls.push(`close:${handle}`)
        if (handle === 2) return true
        closeAttempts++
        return closeAttempts > 1
      },
      lastError: () => 5,
    }
    const owner = WindowsProcessJob.attachForTest(42, runtime)
    calls.length = 0

    expect(() => owner.terminateOrRelease()).toThrow("CloseHandle failed after TerminateJobObject failed: 5")
    expect(calls).toEqual(["terminate", "close:1"])

    owner.terminateOrRelease()
    expect(calls).toEqual(["terminate", "close:1", "terminate", "close:1"])
  })
  test("kills the gated child when the Windows runtime cannot load", async () => {
    const calls: string[] = []
    const child = {
      pid: 42,
      kill() {
        calls.push("kill-child")
        return true
      },
    } as ChildProcess

    await expect(
      WindowsProcessJob.activateForTest({
        child,
        jobRuntime: Promise.reject(new Error("runtime unavailable")),
        openGate: async () => {
          calls.push("open-gate")
        },
        cleanup: () => calls.push("cleanup"),
      }),
    ).rejects.toThrow("runtime unavailable")
    expect(calls).toEqual(["kill-child", "cleanup"])
  })

  test("retries Job handle closure when gate activation fails", async () => {
    const calls: string[] = []
    let closeAttempts = 0
    const runtime: WindowsProcessJob.RuntimeForTest = {
      createJob: () => 1,
      configureJob: () => true,
      openProcess: () => 2,
      assignProcess: () => true,
      terminateJob() {
        calls.push("terminate")
        return false
      },
      closeHandle(handle) {
        calls.push(`close:${handle}`)
        if (handle === 2) return true
        closeAttempts++
        return closeAttempts > 1
      },
      lastError: () => 5,
    }
    const child = {
      pid: 42,
      kill() {
        calls.push("kill-child")
        return true
      },
    } as ChildProcess

    await expect(
      WindowsProcessJob.activateForTest({
        child,
        jobRuntime: runtime,
        openGate: async () => {
          throw new Error("gate unavailable")
        },
        cleanup: () => calls.push("cleanup"),
      }),
    ).rejects.toThrow("gate unavailable")
    expect(calls).toEqual(["close:2", "kill-child", "terminate", "close:1", "close:1", "cleanup"])
  })

  test("reports persistent Job cleanup failure after gate activation fails", async () => {
    const calls: string[] = []
    const runtime: WindowsProcessJob.RuntimeForTest = {
      createJob: () => 1,
      configureJob: () => true,
      openProcess: () => 2,
      assignProcess: () => true,
      terminateJob() {
        calls.push("terminate")
        return false
      },
      closeHandle(handle) {
        calls.push(`close:${handle}`)
        return handle === 2
      },
      lastError: () => 5,
    }
    const child = {
      pid: 42,
      kill() {
        calls.push("kill-child")
        return true
      },
    } as ChildProcess

    const activation = WindowsProcessJob.activateForTest({
      child,
      jobRuntime: runtime,
      openGate: async () => {
        throw new Error("gate unavailable")
      },
      cleanup: () => calls.push("cleanup"),
    })
    await expect(activation).rejects.toThrow("Windows process job activation and cleanup failed")
    expect(calls).toEqual(["close:2", "kill-child", "terminate", "close:1", "close:1", "cleanup"])
  })
})

describe("WindowsProcessJob.prepare", () => {
  test("returns undefined on non-win32 platforms", () => {
    expect(WindowsProcessJob.prepare({ command: "bash", args: ["-c", "echo hi"], env: {} }, "darwin")).toBeUndefined()
    expect(WindowsProcessJob.prepare({ command: "bash", args: ["-c", "echo hi"], env: {} }, "linux")).toBeUndefined()
  })

  test("keeps the selected shell and prepends a gate wait to the command line", () => {
    const prepared = WindowsProcessJob.prepare(
      { command: "C:\\Custom\\bash.exe", args: ["-c", "echo hi"], env: { PATH: "C:\\bin" } },
      "win32",
    )
    expect(prepared).toBeDefined()
    // The caller-selected executable is preserved.
    expect(prepared!.command).toBe("C:\\Custom\\bash.exe")
    // Only the final arg is rewritten: gate prefix + original command.
    expect(prepared!.args[0]).toBe("-c")
    expect(prepared!.args[1]).toContain("SYNERGY_WINDOWS_JOB_GATE")
    expect(prepared!.args[1]).toEndWith("echo hi")
    expect(prepared!.env.SYNERGY_WINDOWS_JOB_GATE).toMatch(/synergy-process-job-.*\.gate$/)
    expect(prepared!.cleanup).toBeDefined()
    prepared!.cleanup()
  })

  test("keeps cmd commands on the command line with cmd-native gate syntax", () => {
    const prepared = WindowsProcessJob.prepare(
      { command: "C:\\Windows\\System32\\cmd.exe", args: ["/d", "/s", "/c", "for %i in (*.txt) do @echo %i"], env: {} },
      "win32",
    )
    expect(prepared).toBeDefined()
    // The selected cmd executable is preserved (not replaced by bare cmd.exe).
    expect(prepared!.command).toBe("C:\\Windows\\System32\\cmd.exe")
    expect(prepared!.args[0]).toBe("/d")
    expect(prepared!.args[1]).toBe("/s")
    expect(prepared!.args[2]).toBe("/c")
    // The user command stays verbatim on the command line (no batch file), so
    // single-percent loop variables keep their /c semantics.
    const gated = prepared!.args[3]
    expect(gated).toContain("for /l %i in (1,1,200)")
    expect(gated).toContain("for %i in (*.txt) do @echo %i")
    expect(prepared!.env.SYNERGY_WINDOWS_JOB_GATE).toBeDefined()
    prepared!.cleanup()
  })

  test("keeps powershell commands on the command line with powershell-native gate syntax", () => {
    const prepared = WindowsProcessJob.prepare(
      { command: "pwsh.exe", args: ["-NoProfile", "-Command", "Write-Host test"], env: {} },
      "win32",
    )
    expect(prepared).toBeDefined()
    expect(prepared!.command).toBe("pwsh.exe")
    expect(prepared!.args[0]).toBe("-NoProfile")
    expect(prepared!.args[1]).toBe("-Command")
    const gated = prepared!.args[2]
    expect(gated).toContain("Test-Path -LiteralPath $g")
    expect(gated).toEndWith("Write-Host test")
    expect(prepared!.env.SYNERGY_WINDOWS_JOB_GATE).toBeDefined()
    prepared!.cleanup()
  })
})
