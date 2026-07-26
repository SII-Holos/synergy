import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import net from "node:net"
import { buildManagedServerEnv, findAvailablePort, terminateServerProcess } from "../src/server-manager.js"

describe("desktop server manager", () => {
  test("allocates a usable localhost port", async () => {
    const port = await findAvailablePort()
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer()
      server.once("error", reject)
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolve())
      })
    })
    expect(port).toBeGreaterThan(0)
  })

  test("overrides only PATH when building the managed server environment", () => {
    expect(
      buildManagedServerEnv(
        {
          HOME: "/Users/example",
          PATH: "/usr/bin:/bin",
          SECRET_FROM_DESKTOP: "preserved-inherited-value",
        },
        {
          source: "login-shell",
          shell: "/bin/zsh",
          path: "/opt/homebrew/bin:/usr/bin:/bin",
          commands: [],
          warning: null,
        },
        {
          channel: "stable",
          parentPid: 42,
          cwd: "/Users/example",
        },
      ),
    ).toEqual({
      HOME: "/Users/example",
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      SECRET_FROM_DESKTOP: "preserved-inherited-value",
      SYNERGY_CWD: "/Users/example",
      SYNERGY_DESKTOP_CHANNEL: "stable",
      SYNERGY_DESKTOP_PARENT_PID: "42",
    })
  })

  test("uses the normalized PATH even when every inherited entry is rejected", () => {
    expect(
      buildManagedServerEnv(
        { PATH: "relative:." },
        {
          source: "inherited",
          shell: null,
          path: "",
          commands: [],
          warning: "login-shell-unavailable",
        },
        { channel: "dev", parentPid: 42, cwd: "/Users/example" },
      ).PATH,
    ).toBe("")
  })

  test.skipIf(process.platform === "win32")("force kills a managed server that ignores SIGTERM", async () => {
    const child = spawn(
      process.execPath,
      ["-e", 'process.on("SIGTERM", () => {}); process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'],
      { stdio: ["ignore", "pipe", "ignore"] },
    )

    try {
      const ready = await new Promise<string>((resolve) => child.stdout.once("data", (chunk) => resolve(String(chunk))))
      expect(ready).toContain("ready")
      await terminateServerProcess(child, 50)
      expect(child.signalCode).toBe("SIGKILL")
      expect(isProcessRunning(child.pid ?? 0)).toBe(false)
    } finally {
      child.kill("SIGKILL")
    }
  })
})

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
