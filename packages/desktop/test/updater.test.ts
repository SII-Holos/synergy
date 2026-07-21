import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { DesktopUpdateStore, DesktopUpdater, type DesktopUpdateBackend } from "../src/updater.js"

class FakeBackend implements DesktopUpdateBackend {
  readonly events = new EventEmitter()
  version: string | null = null
  checks = 0
  downloads = 0
  installs = 0

  async checkForUpdates(): Promise<{ version: string | null }> {
    this.checks++
    return { version: this.version }
  }

  async downloadUpdate(): Promise<void> {
    this.downloads++
    this.events.emit("download-progress", { percent: 50 })
    this.events.emit("update-downloaded", { version: this.version ?? undefined })
  }

  quitAndInstall(): void {
    this.installs++
  }

  on(event: Parameters<DesktopUpdateBackend["on"]>[0], listener: (...args: any[]) => void): () => void {
    this.events.on(event, listener)
    return () => this.events.off(event, listener)
  }
}

describe("desktop updater", () => {
  test("stores update mode and recovers corrupt preference files", async () => {
    await using tmp = await tempdir()
    const store = new DesktopUpdateStore(path.join(tmp.path, "desktop-update.json"))
    expect(await store.read()).toEqual({ mode: "auto" })
    await store.write({ mode: "manual" })
    expect(await store.read()).toEqual({ mode: "manual" })
    await fs.writeFile(path.join(tmp.path, "desktop-update.json"), "{broken")
    expect(await store.read()).toEqual({ mode: "auto" })
  })

  test("dev channel is disabled and does not check", async () => {
    await using tmp = await tempdir()
    const backend = new FakeBackend()
    const updater = new DesktopUpdater({
      channel: "dev",
      currentVersion: "1.0.0",
      userDataDir: tmp.path,
      stopServer: async () => {},
      backend,
    })
    await updater.init()
    const status = await updater.check({ manual: true })
    expect(status.phase).toBe("disabled")
    expect(backend.checks).toBe(0)
  })

  test("auto mode downloads available updates", async () => {
    await using tmp = await tempdir()
    const backend = new FakeBackend()
    backend.version = "1.0.1"
    const updater = new DesktopUpdater({
      channel: "stable",
      currentVersion: "1.0.0",
      userDataDir: tmp.path,
      stopServer: async () => {},
      backend,
    })
    await updater.setMode("auto")
    const status = await updater.check({ manual: true })
    expect(status.phase).toBe("ready")
    expect(status.availableVersion).toBe("1.0.1")
    expect(backend.downloads).toBeGreaterThan(0)
  })

  test("mode changes preserve ready updates unless updates are disabled", async () => {
    await using tmp = await tempdir()
    const backend = new FakeBackend()
    backend.version = "1.0.1"
    const updater = new DesktopUpdater({
      channel: "stable",
      currentVersion: "1.0.0",
      userDataDir: tmp.path,
      stopServer: async () => {},
      backend,
    })
    await updater.setMode("auto")
    await updater.check({ manual: true })

    expect((await updater.setMode("notify")).phase).toBe("ready")
    const disabled = await updater.setMode("none")
    expect(disabled.phase).toBe("disabled")
    expect(disabled.availableVersion).toBeNull()
  })

  test("install stops the managed server before quitting into installer", async () => {
    await using tmp = await tempdir()
    const backend = new FakeBackend()
    const calls: string[] = []
    const updater = new DesktopUpdater({
      channel: "stable",
      currentVersion: "1.0.0",
      userDataDir: tmp.path,
      stopServer: async () => {
        calls.push("stop")
      },
      backend,
    })
    await updater.init()
    await updater.installAndRestart()
    calls.push("after")
    expect(calls).toEqual(["stop", "after"])
    expect(backend.installs).toBe(1)
  })
})

async function tempdir() {
  const path = await fs.mkdtemp(pathJoin(os.tmpdir(), "synergy-desktop-updater-"))
  return {
    path,
    async [Symbol.asyncDispose]() {
      await fs.rm(path, { recursive: true, force: true })
    },
  }
}

function pathJoin(...parts: string[]) {
  return path.join(...parts)
}
