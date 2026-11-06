import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DesktopServerManager } from "../src/server-manager"

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
async function fixture(mode: string, resolve: () => Promise<null> = async () => null) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-maintenance-"))
  const resourcesPath = path.join(root, "resources")
  const binary = path.join(resourcesPath, "synergy", "bin", "synergy")
  await fs.mkdir(path.dirname(binary), { recursive: true })
  await fs.writeFile(path.join(root, "mode"), mode)
  await fs.writeFile(
    binary,
    `#!/bin/sh\nMAINTENANCE_FIXTURE_ROOT=${quote(root)} exec ${quote(process.execPath)} ${quote(path.join(import.meta.dir, "fixture/maintenance-server.ts"))} "$@"\n`,
    { mode: 0o755 },
  )
  const manager = new DesktopServerManager({
    mode: "managed",
    channel: "dev",
    resourcesPath,
    logDir: path.join(root, "logs"),
    userDataPath: root,
    shellEnvironment: { resolve } as never,
  })
  return {
    root,
    manager,
    async [Symbol.asyncDispose]() {
      await manager.stop()
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

const supported = process.platform !== "win32"
test.skipIf(!supported || process.env.SYNERGY_DESKTOP_LONG_MAINTENANCE_TEST !== "1")(
  "a controlled maintenance interval beyond five minutes completes and restarts",
  async () => {
    await using runtime = await fixture("controlled-delay")
    const started = Date.now()
    const url = await runtime.manager.runMaintenance()
    expect(Date.now() - started).toBeGreaterThan(300_000)
    expect((await fetch(`${url}/global/health`)).ok).toBe(true)
    expect(runtime.manager.status().maintenance).toMatchObject({
      state: "completed",
      progress: { current: 512, total: 0 },
    })
  },
  350_000,
)
test.skipIf(!supported)(
  "maintenance refuses active work without stopping its owned server",
  async () => {
    await using runtime = await fixture("busy")
    const url = await runtime.manager.start()
    await expect(runtime.manager.runMaintenance()).rejects.toThrow("working")
    expect(runtime.manager.status().state).toBe("running")
    expect((await fetch(`${url}/global/health`)).ok).toBe(true)
  },
  30000,
)

test.skipIf(!supported)(
  "duplicate maintenance requests share one child and shutdown cannot launch a replacement",
  async () => {
    await using runtime = await fixture("hold")
    const first = runtime.manager.runMaintenance()
    const second = runtime.manager.runMaintenance()
    void first.catch(() => {})
    void second.catch(() => {})
    while (!runtime.manager.status().maintenance.progress) await Bun.sleep(10)
    await expect(runtime.manager.restart()).rejects.toThrow("maintenance")
    expect(runtime.manager.status().maintenance.progress?.current).toBe(256)
    await runtime.manager.stop()
    await expect(first).rejects.toThrow()
    await expect(second).rejects.toThrow()
    expect((await Bun.file(path.join(runtime.root, "commands")).text()).trim().split("\n")).toEqual(["migration"])
  },
  30000,
)

test.skipIf(!supported)(
  "failed maintenance keeps retry available and does not fabricate completion",
  async () => {
    await using runtime = await fixture("failure")
    await expect(runtime.manager.runMaintenance()).rejects.toThrow("disk is full")
    expect(runtime.manager.status().maintenance.state).toBe("failed")
    await runtime.manager.start()
    expect(runtime.manager.status().state).toBe("running")
  },
  30000,
)

test.skipIf(!supported)(
  "successful explicit maintenance restarts and diagnostics uses a writable output path",
  async () => {
    await using runtime = await fixture("success")
    const url = await runtime.manager.runMaintenance()
    expect((await fetch(`${url}/global/health`)).ok).toBe(true)
    expect(runtime.manager.status().maintenance.state).toBe("completed")
    const output = await runtime.manager.createDiagnostics()
    expect(await Bun.file(output).text()).toBe("fixture diagnostics")
  },
  30000,
)

test.skipIf(!supported)("shutdown during environment resolution cannot launch an orphan server", async () => {
  const environment = Promise.withResolvers<null>()
  await using runtime = await fixture("success", () => environment.promise)
  const startup = runtime.manager.start()
  void startup.catch(() => {})
  const stopping = runtime.manager.stop()
  environment.resolve(null)
  await expect(startup).rejects.toThrow("cancelled")
  await stopping
  expect(await Bun.file(path.join(runtime.root, "commands")).exists()).toBe(false)
})

test.skipIf(!supported)(
  "expired-evidence maintenance uses the prune command and restarts its owned server",
  async () => {
    await using runtime = await fixture("success")
    await runtime.manager.start()
    const url = await runtime.manager.runMaintenance("prune")
    expect((await fetch(`${url}/global/health`)).ok).toBe(true)
    expect(runtime.manager.status().maintenance.state).toBe("completed")
    expect((await Bun.file(path.join(runtime.root, "commands")).text()).trim().split("\n")).toEqual([
      "server",
      "data",
      "server",
    ])
  },
  30_000,
)
