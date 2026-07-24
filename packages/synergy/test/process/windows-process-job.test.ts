import { describe, expect, test } from "bun:test"
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
})
