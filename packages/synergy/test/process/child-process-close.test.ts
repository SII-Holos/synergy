import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { ChildProcessClose } from "../../src/process/child-process-close"
import { Shell } from "../../src/util/shell"

function processGroupExists(pid: number) {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

describe("ChildProcessClose", () => {
  test.skipIf(process.platform === "win32")("bounds drainage when a descendant inherits stdout", async () => {
    const child = spawn("/bin/sh", ["-c", "(sleep 0.25) &"], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    const startedAt = performance.now()

    const result = await ChildProcessClose.wait(child, { drainGraceMs: 20 })

    expect(result.drainTimedOut).toBe(true)
    expect(result.code).toBe(0)
    expect(performance.now() - startedAt).toBeLessThan(200)
  })

  test.skipIf(process.platform === "win32")("retains output produced during the bounded drain window", async () => {
    const child = spawn("/bin/sh", ["-c", "(sleep 0.02; printf late-tail) &"], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString()
    })

    const result = await ChildProcessClose.wait(child, { drainGraceMs: 100 })

    expect(result.drainTimedOut).toBe(false)
    expect(output).toContain("late-tail")
  })

  test.skipIf(process.platform === "win32")(
    "settles drain-timeout cleanup before releasing an untracked child",
    async () => {
      const child = spawn("/bin/sh", ["-c", "(sleep 5) &"], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
      const pid = child.pid!

      try {
        let parentExited = false
        const result = await ChildProcessClose.wait(child, {
          drainGraceMs: 20,
          onExit() {
            parentExited = true
          },
          onDrainTimeout: () =>
            Shell.killTree(child, {
              exited: () => parentExited,
              allowExitedParent: true,
            }),
        })

        expect(parentExited).toBe(true)
        expect(result.drainTimedOut).toBe(true)
        expect(processGroupExists(pid)).toBe(false)
      } finally {
        if (processGroupExists(pid)) process.kill(-pid, "SIGKILL")
      }
    },
  )
})
