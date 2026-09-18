import { describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import net from "node:net"
import { DesktopServerStartup } from "../src/server-startup.js"
import {
  attachManagedServerExitHandlers,
  buildManagedServerEnv,
  findAvailablePort,
  isPortAvailable,
  managedServerArgs,
  managedServerPortCandidates,
  managedServerPortFromEnv,
  terminateServerProcess,
  waitForHealth,
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
      SYNERGY_DESKTOP_STARTUP_PROGRESS: "1",
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

  test("observes the Windows fallback kill within the remaining shutdown budget", async () => {
    const server = new ChildProcessFixture()
    const taskkills: ChildProcessFixture[] = []
    server.kill = (signal?: NodeJS.Signals) => {
      server.killedSignals.push(signal)
      queueMicrotask(() => {
        server.signalCode = signal ?? null
        server.emit("exit", null, signal ?? null)
      })
      return true
    }

    const result = terminateServerProcess(server as unknown as ChildProcess, 100, {
      platform: "win32",
      spawnTaskkill: () => {
        const taskkill = new ChildProcessFixture()
        taskkills.push(taskkill)
        queueMicrotask(() => taskkill.emit("error", new Error("taskkill unavailable")))
        return taskkill as unknown as ChildProcess
      },
    })

    await expect(result).resolves.toBe(true)
    expect(taskkills).toHaveLength(2)
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

  test("waits for health using the progressing migration budget", async () => {
    const child = new ChildProcessFixture() as unknown as ChildProcess
    let now = 0
    const startup = new DesktopServerStartup({ now: () => now })
    startup.receive('SYNERGY_STARTUP_V1 {"phase":"migration","step":1,"current":0,"total":10}\n')
    const originalFetch = globalThis.fetch
    let requests = 0
    globalThis.fetch = (async () => {
      if (++requests === 1) {
        now = 60_000
        startup.receive('SYNERGY_STARTUP_V1 {"phase":"migration","step":1,"current":1,"total":10}\n')
        return new Response(null, { status: 503 })
      }
      return new Response("healthy")
    }) as typeof fetch
    try {
      await waitForHealth("http://127.0.0.1:1/global/health", child, 0, 0, startup)
      expect(requests).toBe(2)
      now = 360_000
      await expect(waitForHealth("http://127.0.0.1:1/global/health", child, 0, 0, startup)).rejects.toThrow(
        "no progress",
      )
    } finally {
      globalThis.fetch = originalFetch
    }
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

describe("desktop managed server port chain", () => {
  test("prefers the environment port, then sticky, then the default scan range", () => {
    expect(managedServerPortCandidates({ envPort: 5000, stickyPort: 4097 })).toEqual([5000, 4097, 4096, 4098, 4099])
    expect(managedServerPortCandidates({ stickyPort: 4097 })).toEqual([4097, 4096, 4098, 4099])
    expect(managedServerPortCandidates({})).toEqual([4096, 4097, 4098, 4099])
  })

  test("deduplicates candidates and drops unassignable ports", () => {
    expect(managedServerPortCandidates({ envPort: 4096, stickyPort: 4096 })).toEqual([4096, 4097, 4098, 4099])
    expect(managedServerPortCandidates({ envPort: 80, stickyPort: 70_000 })).toEqual([4096, 4097, 4098, 4099])
    expect(managedServerPortCandidates({ envPort: 4097, stickyPort: 4098, scanLength: 0 })).toEqual([4097, 4098])
  })

  test("reads only a valid port from the environment", () => {
    expect(managedServerPortFromEnv({ SYNERGY_DESKTOP_SERVER_PORT: "4100" })).toBe(4100)
    for (const value of ["", "0", "not-a-port", "80", "70000", "4100.5"]) {
      expect(managedServerPortFromEnv({ SYNERGY_DESKTOP_SERVER_PORT: value })).toBeUndefined()
    }
    expect(managedServerPortFromEnv({})).toBeUndefined()
  })

  test("reports a port as unavailable while another listener holds it", async () => {
    const competitor = net.createServer()
    await new Promise<void>((resolve, reject) => {
      competitor.once("error", reject)
      competitor.listen(0, "127.0.0.1", () => resolve())
    })
    const occupied = (competitor.address() as net.AddressInfo).port
    try {
      expect(await isPortAvailable(occupied)).toBe(false)
    } finally {
      await new Promise<void>((resolve) => competitor.close(() => resolve()))
    }
    expect(await isPortAvailable(occupied)).toBe(true)
  })
})
