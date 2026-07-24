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
    expect(calls).toEqual(["create-job", "open-process:42", "assign-process", "close:2"])

    owner.terminate()
    owner.release()
    expect(calls).toEqual(["create-job", "open-process:42", "assign-process", "close:2", "terminate-job", "close:1"])
  })

  test("fails closed and releases handles when assignment fails", () => {
    const closed: number[] = []
    const runtime: WindowsProcessJob.RuntimeForTest = {
      createJob: () => 1,
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
})
