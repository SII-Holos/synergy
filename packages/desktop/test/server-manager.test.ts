import { describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import net from "node:net"
import {
  attachManagedServerExitHandlers,
  buildManagedServerEnv,
  findAvailablePort,
  findListeningPort,
  managedServerArgs,
  parseListeningPort,
  terminateServerProcess,
  waitForHealth,
  waitForWindowsServerHealth,
} from "../src/server-manager.js"

describe("desktop server manager", () => {
  test("always binds managed servers to loopback", () => {
    expect(managedServerArgs(43121)).toEqual(["server", "--port", "43121", "--hostname", "127.0.0.1"])
  })

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

  test("parses netstat listening entries for IPv4 and IPv6", () => {
    const output = [
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    127.0.0.1:3000         0.0.0.0:0              LISTENING       1234",
      "  TCP    [::1]:4321             [::]:0                 LISTENING       5678",
    ].join("\r\n")

    expect(parseListeningPort(output, 1234)).toBe(3000)
    expect(parseListeningPort(output, 5678)).toBe(4321)
    expect(parseListeningPort(output, 9012)).toBeNull()
  })

  test("bounds a health check by its total timeout", async () => {
    const child = new ChildProcessFixture() as unknown as ChildProcess
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch

    try {
      await expect(waitForHealth("http://127.0.0.1:1/global/health", child, 25, 1)).rejects.toThrow(
        "health check timed out after 25ms",
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("fails immediately on a child error and cleans up both child listeners", async () => {
    const child = new ChildProcessFixture() as unknown as ChildProcess
    const originalFetch = globalThis.fetch
    let rejectFetch: ((reason?: unknown) => void) | undefined
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        rejectFetch = reject
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
      })) as typeof fetch

    const pending = waitForHealth("http://127.0.0.1:1/global/health", child, 30_000, 1_000)
    child.emit("error", new Error("spawn ENOENT"))
    const result = await Promise.race([
      pending.then(
        () => "resolved",
        (error) => error,
      ),
      new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), 100)),
    ])

    if (result === "timed out") {
      child.exitCode = 1
      child.emit("exit", 1, null)
      rejectFetch?.(new Error("test cleanup"))
      await pending.catch(() => {})
    }

    try {
      expect(result).toBeInstanceOf(Error)
      expect((result as Error).message).toContain("spawn ENOENT")
      expect(child.listenerCount("error")).toBe(0)
      expect(child.listenerCount("exit")).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("fails immediately on a Windows child error and wins an exit race", async () => {
    const child = new ChildProcessFixture() as unknown as ChildProcess
    const pending = waitForWindowsServerHealth(child, 30_000)
    child.emit("error", new Error("spawn EACCES"))
    child.exitCode = 1
    child.emit("exit", 1, null)

    await expect(pending).rejects.toThrow("spawn EACCES")
    expect(child.listenerCount("error")).toBe(0)
    expect(child.listenerCount("exit")).toBe(0)
  })

  test("closes the server log stream once on spawn error or close", () => {
    for (const event of ["error", "close"] as const) {
      const child = new ChildProcessFixture() as unknown as ChildProcess
      const logStream = new LogStreamFixture()
      const failures: string[] = []
      attachManagedServerExitHandlers(child, logStream as never, (details) => failures.push(details))

      if (event === "error") child.emit("error", new Error("spawn ENOENT"))
      else child.emit("close", 1, null)
      child.emit("close", 1, null)

      expect(logStream.endCount).toBe(1)
      expect(logStream.writes).toHaveLength(1)
      expect(failures).toHaveLength(1)
      expect(child.listenerCount("error")).toBe(0)
      expect(child.listenerCount("close")).toBe(0)
    }
  })

  test("cleans up taskkill listeners after an exit and reports confirmed Windows termination", async () => {
    const server = new ChildProcessFixture() as unknown as ChildProcess
    let taskkill: ChildProcessFixture | undefined
    const result = terminateServerProcess(server, 100, {
      platform: "win32",
      spawnTaskkill: () => {
        taskkill = new ChildProcessFixture()
        queueMicrotask(() => {
          taskkill!.exitCode = 0
          taskkill!.emit("exit", 0, null)
          server.exitCode = 0
          server.emit("exit", 0, null)
        })
        return taskkill as unknown as ChildProcess
      },
    })

    await expect(result).resolves.toBe(true)
    expect(taskkill?.listenerCount("exit")).toBe(0)
    expect(taskkill?.listenerCount("error")).toBe(0)
  })

  test("cleans up taskkill listeners after error and reports failed Windows termination at the deadline", async () => {
    const server = new ChildProcessFixture() as unknown as ChildProcess
    const taskkill = new ChildProcessFixture()
    const result = terminateServerProcess(server, 25, {
      platform: "win32",
      spawnTaskkill: () => {
        queueMicrotask(() => taskkill.emit("error", new Error("taskkill unavailable")))
        return taskkill as unknown as ChildProcess
      },
    })

    await expect(result).resolves.toBe(false)
    expect(taskkill.listenerCount("exit")).toBe(0)
    expect(taskkill.listenerCount("error")).toBe(0)
    expect(taskkill.killedSignals).toEqual([undefined])
    expect(server.killedSignals).toEqual(["SIGKILL"])
  })

  test("cleans up both taskkill listeners when the taskkill wait times out", async () => {
    const server = new ChildProcessFixture() as unknown as ChildProcess
    const taskkill = new ChildProcessFixture()

    await expect(
      terminateServerProcess(server, 15, {
        platform: "win32",
        spawnTaskkill: () => taskkill as unknown as ChildProcess,
      }),
    ).resolves.toBe(false)
    expect(taskkill.listenerCount("exit")).toBe(0)
    expect(taskkill.listenerCount("error")).toBe(0)
  })

  test("uses the bounded health timeout for managed non-Windows startup", async () => {
    const source = await Bun.file(new URL("../src/server-manager.ts", import.meta.url)).text()
    expect(source).toContain("await waitForHealth(`${this.url}${HEALTH_PATH}`, child, HEALTH_TIMEOUT_MS)")
  })

  test.skipIf(process.platform !== "win32")(
    "discovers the atomically assigned child port while a competing port is occupied",
    async () => {
      const competitor = net.createServer()
      await listen(competitor, 0)
      const occupiedPort = (competitor.address() as net.AddressInfo).port
      const child = spawn(
        process.execPath,
        [
          "-e",
          'const net = require("node:net"); const server = net.createServer(); server.listen(0, "127.0.0.1"); setInterval(() => {}, 1000)',
        ],
        { stdio: "ignore", windowsHide: true },
      )

      try {
        let port: number | null = null
        for (let attempt = 0; attempt < 20 && port === null; attempt++) {
          port = await findListeningPort(child.pid ?? 0, 100)
          if (port === null) await new Promise((resolve) => setTimeout(resolve, 25))
        }
        expect(port).not.toBeNull()
        expect(port).not.toBe(occupiedPort)
      } finally {
        await terminateServerProcess(child, 500)
        await new Promise<void>((resolve) => competitor.close(() => resolve()))
      }
    },
  )

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

  test.skipIf(process.platform !== "win32")("kills a managed server's complete process tree", async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        'const { spawn } = require("node:child_process"); const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); process.stdout.write(String(grandchild.pid)); setInterval(() => {}, 1000)',
      ],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    )

    try {
      const grandchildPid = Number(
        await new Promise<string>((resolve) => child.stdout?.once("data", (chunk) => resolve(String(chunk)))),
      )
      expect(grandchildPid).toBeGreaterThan(0)
      await terminateServerProcess(child, 500)
      await waitUntilStopped(grandchildPid)
      expect(isProcessRunning(child.pid ?? 0)).toBe(false)
      expect(isProcessRunning(grandchildPid)).toBe(false)
    } finally {
      if (isProcessRunning(child.pid ?? 0)) await terminateServerProcess(child, 500)
    }
  })
})

function listen(server: net.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => resolve())
  })
}

async function waitUntilStopped(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!isProcessRunning(pid)) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

class ChildProcessFixture extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  pid = 1234
  killedSignals: Array<NodeJS.Signals | undefined> = []

  kill(signal?: NodeJS.Signals): boolean {
    this.killedSignals.push(signal)
    return true
  }
}

class LogStreamFixture {
  writes: string[] = []
  endCount = 0

  write(value: string): boolean {
    this.writes.push(value)
    return true
  }

  end(): this {
    this.endCount++
    return this
  }
}
