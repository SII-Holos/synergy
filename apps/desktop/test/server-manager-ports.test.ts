import { describe, expect, test } from "bun:test"
import fsp from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { DesktopServerManager } from "../src/server-manager.js"
import { desktopServerPortFilePath, saveServerPort } from "../src/server-port-state.js"

const TEST_TIMEOUT_MS = 30_000
const FIXTURE_PATH = path.resolve(import.meta.dir, "fixture/fake-synergy-server.ts")
const SCAN_PORTS = [4096, 4097, 4098, 4099]

// These cases exercise the real default port chain, so they need the whole scan range free.
// A developer machine already running Synergy on those ports skips them instead of failing.
const scanRangeFree = process.platform !== "win32" && (await Promise.all(SCAN_PORTS.map(isFree))).every(Boolean)

async function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once("error", () => resolve(false))
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)))
  })
}

async function occupy(port: number): Promise<{ release: () => Promise<void> }> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => resolve())
  })
  return { release: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

interface FakeRuntime {
  userDataPath: string
  start: () => Promise<string>
  attempts: () => Promise<number[]>
  stopAll: () => Promise<void>
  lastError: () => string | null
  cleanup: () => Promise<void>
}

async function createFakeRuntime(options: {
  channel?: "dev" | "stable"
  modes?: Record<string, "ok" | "conflict" | "other">
}): Promise<FakeRuntime> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "synergy-desktop-ports-"))
  const userDataPath = path.join(root, "user-data")
  const logDir = path.join(root, "logs")
  const attemptsFile = path.join(root, "attempts.txt")
  const modesFile = path.join(root, "modes.json")
  const resourcesPath = path.join(root, "resources")
  const binaryDirectory = path.join(resourcesPath, "synergy", "bin")
  const binary = path.join(binaryDirectory, "synergy")

  await fsp.mkdir(logDir, { recursive: true })
  await fsp.writeFile(path.join(logDir, "server.log"), "old-launch-private-error\n")
  await fsp.writeFile(modesFile, JSON.stringify(options.modes ?? {}), "utf8")
  await fsp.mkdir(binaryDirectory, { recursive: true })
  // The manager spawns the packaged runtime when that path exists, so a generated wrapper drives the
  // real spawn/probe/health/retry path without requiring a built preset runtime.
  await fsp.writeFile(
    binary,
    [
      "#!/bin/sh",
      `FAKE_SYNERGY_ATTEMPTS=${shellQuote(attemptsFile)} FAKE_SYNERGY_MODES_FILE=${shellQuote(modesFile)} exec ${shellQuote(process.execPath)} ${shellQuote(FIXTURE_PATH)} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  )

  const managers: DesktopServerManager[] = []
  const create = () => {
    const manager = new DesktopServerManager({
      channel: options.channel ?? "dev",
      mode: "managed",
      resourcesPath,
      logDir,
      userDataPath,
      // Keeps the suite off the login-shell probe; the port chain does not depend on it.
      shellEnvironment: { resolve: async () => null } as never,
    })
    managers.push(manager)
    return manager
  }

  return {
    userDataPath,
    start: () => create().start(),
    attempts: async () => {
      const content = await fsp.readFile(attemptsFile, "utf8").catch(() => "")
      return content.split("\n").filter(Boolean).map(Number)
    },
    lastError: () => managers.at(-1)?.status().lastError ?? null,
    stopAll: async () => {
      for (const manager of managers) await manager.stop()
    },
    cleanup: async () => {
      await fsp.rm(root, { recursive: true, force: true })
    },
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

async function readState(userDataPath: string): Promise<unknown> {
  return JSON.parse(await fsp.readFile(desktopServerPortFilePath(userDataPath), "utf8"))
}

describe("desktop managed server sticky port", () => {
  test.skipIf(!scanRangeFree)(
    "binds the default port first and reuses the persisted port on the next launch",
    async () => {
      const runtime = await createFakeRuntime({})
      try {
        expect(await runtime.start()).toBe("http://127.0.0.1:4096")
        expect((await readState(runtime.userDataPath)) as object).toMatchObject({
          version: 1,
          channel: "dev",
          port: 4096,
        })

        await runtime.stopAll()
        expect(await runtime.start()).toBe("http://127.0.0.1:4096")
        expect(await runtime.attempts()).toEqual([4096, 4096])
      } finally {
        await runtime.stopAll()
        await runtime.cleanup()
      }
    },
    TEST_TIMEOUT_MS,
  )

  test.skipIf(!scanRangeFree)(
    "reuses the persisted port instead of the default",
    async () => {
      const runtime = await createFakeRuntime({})
      await saveServerPort(runtime.userDataPath, "dev", 4098)
      try {
        expect(await runtime.start()).toBe("http://127.0.0.1:4098")
        expect(await runtime.attempts()).toEqual([4098])
      } finally {
        await runtime.stopAll()
        await runtime.cleanup()
      }
    },
    TEST_TIMEOUT_MS,
  )

  test.skipIf(!scanRangeFree)(
    "ignores a persisted port owned by the other channel",
    async () => {
      const runtime = await createFakeRuntime({ channel: "dev" })
      await saveServerPort(runtime.userDataPath, "stable", 4098)
      try {
        expect(await runtime.start()).toBe("http://127.0.0.1:4096")
      } finally {
        await runtime.stopAll()
        await runtime.cleanup()
      }
    },
    TEST_TIMEOUT_MS,
  )

  test.skipIf(!scanRangeFree)(
    "skips an occupied default port and persists the next candidate",
    async () => {
      const runtime = await createFakeRuntime({})
      const occupant = await occupy(4096)
      try {
        expect(await runtime.start()).toBe("http://127.0.0.1:4097")
        expect((await readState(runtime.userDataPath)) as object).toMatchObject({ port: 4097 })
        expect(await runtime.attempts()).toEqual([4097])
      } finally {
        await runtime.stopAll()
        await occupant.release()
        await runtime.cleanup()
      }
    },
    TEST_TIMEOUT_MS,
  )

  test.skipIf(!scanRangeFree)(
    "advances past a candidate whose server reports a port bind failure",
    async () => {
      const runtime = await createFakeRuntime({ modes: { 4096: "conflict" } })
      try {
        expect(await runtime.start()).toBe("http://127.0.0.1:4097")
        expect(await runtime.attempts()).toEqual([4096, 4097])
        expect((await readState(runtime.userDataPath)) as object).toMatchObject({ port: 4097 })
      } finally {
        await runtime.stopAll()
        await runtime.cleanup()
      }
    },
    TEST_TIMEOUT_MS,
  )

  test.skipIf(!scanRangeFree)(
    "clears the failed candidate's error once a later candidate serves",
    async () => {
      const runtime = await createFakeRuntime({ modes: { 4096: "conflict" } })
      try {
        expect(await runtime.start()).toBe("http://127.0.0.1:4097")
        expect(runtime.lastError()).toBeNull()
      } finally {
        await runtime.stopAll()
        await runtime.cleanup()
      }
    },
    TEST_TIMEOUT_MS,
  )

  test.skipIf(!scanRangeFree)(
    "does not retry a startup failure that is not a port conflict",
    async () => {
      const runtime = await createFakeRuntime({ modes: { 4096: "other" } })
      try {
        await expect(runtime.start()).rejects.toThrow()
        expect(await runtime.attempts()).toEqual([4096])
        expect(runtime.lastError()).toContain("Another Synergy runtime already owns this Home")
        expect(runtime.lastError()).not.toContain("old-launch-private-error")
      } finally {
        await runtime.stopAll()
        await runtime.cleanup()
      }
    },
    TEST_TIMEOUT_MS,
  )

  test.skipIf(!scanRangeFree)(
    "persists the channel that claimed the port",
    async () => {
      const runtime = await createFakeRuntime({ channel: "stable" })
      try {
        await runtime.start()
        expect((await readState(runtime.userDataPath)) as object).toMatchObject({
          channel: "stable",
          port: 4096,
        })
      } finally {
        await runtime.stopAll()
        await runtime.cleanup()
      }
    },
    TEST_TIMEOUT_MS,
  )

  test.skipIf(!scanRangeFree)(
    "falls back to a random port without persisting it when the scan range is full",
    async () => {
      const runtime = await createFakeRuntime({})
      const occupants = await Promise.all(SCAN_PORTS.map((port) => occupy(port)))
      try {
        const url = await runtime.start()
        const port = Number(new URL(url).port)
        expect(SCAN_PORTS).not.toContain(port)
        expect(port).toBeGreaterThan(0)
        await expect(fsp.access(desktopServerPortFilePath(runtime.userDataPath))).rejects.toThrow()
      } finally {
        await runtime.stopAll()
        await Promise.all(occupants.map((occupant) => occupant.release()))
        await runtime.cleanup()
      }
    },
    TEST_TIMEOUT_MS,
  )
})
