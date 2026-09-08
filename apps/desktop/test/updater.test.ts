import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import {
  DesktopUpdateCancelledError,
  DesktopUpdateStore,
  DesktopUpdater,
  ElectronUpdateBackend,
  desktopUpdateInstallActive,
  type DesktopUpdateBackend,
} from "../src/updater.js"

class FakeBackend implements DesktopUpdateBackend {
  readonly events = new EventEmitter()
  version: string | null = null
  checks = 0
  downloads = 0
  cancels = 0
  installs = 0
  downloadPromise: Promise<void> | null = null
  downloadError: Error | null = null
  installError: Error | null = null

  async checkForUpdates(): Promise<{ version: string | null }> {
    this.checks++
    return { version: this.version }
  }

  async downloadUpdate(): Promise<void> {
    this.downloads++
    this.events.emit("download-progress", { percent: 50 })
    if (this.downloadPromise) await this.downloadPromise
    if (this.downloadError) throw this.downloadError
    this.events.emit("update-downloaded", { version: this.version ?? undefined })
  }

  cancelDownload(): void {
    this.cancels++
    this.events.emit("update-cancelled")
  }

  quitAndInstall(): void {
    this.installs++
    if (this.installError) throw this.installError
  }

  on(event: Parameters<DesktopUpdateBackend["on"]>[0], listener: (...args: any[]) => void): () => void {
    this.events.on(event, listener)
    return () => this.events.off(event, listener)
  }
}

class FakeElectronAutoUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowPrerelease = true
  checkResult = { isUpdateAvailable: false, updateInfo: { version: "3.0.7" }, cancellationToken: { cancel() {} } }

  async checkForUpdates() {
    return this.checkResult
  }

  async downloadUpdate(): Promise<void> {}

  quitAndInstall(): void {}
}

describe("desktop updater", () => {
  test("ignores release metadata when Electron reports no available update", async () => {
    const autoUpdater = new FakeElectronAutoUpdater()
    const backend = new ElectronUpdateBackend(async () => autoUpdater)

    expect(await backend.checkForUpdates()).toEqual({ version: null })

    autoUpdater.checkResult = { isUpdateAvailable: true, updateInfo: { version: "3.0.8" } }
    expect(await backend.checkForUpdates()).toEqual({ version: "3.0.8" })
  })

  test("disables implicit install-on-quit in the Electron backend", async () => {
    const autoUpdater = new FakeElectronAutoUpdater()
    const backend = new ElectronUpdateBackend(async () => autoUpdater)

    await backend.checkForUpdates()

    expect(autoUpdater.autoDownload).toBe(false)
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false)
    expect(autoUpdater.allowPrerelease).toBe(false)
  })

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

  test("cancels an in-flight download and ignores late events when updates are disabled", async () => {
    await using tmp = await tempdir()
    const backend = new FakeBackend()
    backend.version = "1.0.1"
    let releaseDownload!: () => void
    backend.downloadPromise = new Promise<void>((resolve) => {
      releaseDownload = resolve
    })
    const updater = new DesktopUpdater({
      channel: "stable",
      currentVersion: "1.0.0",
      userDataDir: tmp.path,
      stopServer: async () => {},
      backend,
    })
    await updater.setMode("auto")
    const checking = updater.check({ manual: true })
    await waitFor(() => updater.getStatus().phase === "downloading")

    expect((await updater.setMode("none")).phase).toBe("disabled")
    expect(backend.cancels).toBe(1)
    backend.events.emit("download-progress", { percent: 90 })
    backend.events.emit("update-downloaded", { version: "1.0.1" })
    expect(updater.getStatus().phase).toBe("disabled")

    releaseDownload()
    await checking
    expect(updater.getStatus().phase).toBe("disabled")
  })

  test("keeps a cancelled download available for an explicit retry", async () => {
    await using tmp = await tempdir()
    const backend = new FakeBackend()
    backend.version = "1.0.1"
    backend.downloadError = new DesktopUpdateCancelledError()
    const updater = new DesktopUpdater({
      channel: "stable",
      currentVersion: "1.0.0",
      userDataDir: tmp.path,
      stopServer: async () => {},
      backend,
    })
    await updater.setMode("notify")
    await updater.check({ manual: true })

    const status = await updater.download()

    expect(status.phase).toBe("available")
    expect(status.error).toBeNull()
  })

  test("install stops the managed server before quitting into installer", async () => {
    await using tmp = await tempdir()
    const backend = new FakeBackend()
    backend.version = "1.0.1"
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
    await updater.setMode("auto")
    await updater.check({ manual: true })
    await updater.installAndRestart()
    calls.push("after")
    expect(calls).toEqual(["stop", "after"])
    expect(backend.installs).toBe(1)
  })

  test("does not stop the server unless an update is ready", async () => {
    await using tmp = await tempdir()
    const backend = new FakeBackend()
    let stops = 0
    const updater = new DesktopUpdater({
      channel: "stable",
      currentVersion: "1.0.0",
      userDataDir: tmp.path,
      stopServer: async () => {
        stops++
      },
      backend,
    })
    await updater.init()

    expect((await updater.installAndRestart()).phase).toBe("idle")
    expect(stops).toBe(0)
    expect(backend.installs).toBe(0)
  })

  test("restarts the managed server when updater installation dispatch fails", async () => {
    await using tmp = await tempdir()
    const backend = new FakeBackend()
    backend.version = "1.0.1"
    backend.installError = new Error("installer unavailable")
    const calls: string[] = []
    const updater = new DesktopUpdater({
      channel: "stable",
      currentVersion: "1.0.0",
      userDataDir: tmp.path,
      stopServer: async () => {
        calls.push("stop")
      },
      restartServer: async () => {
        calls.push("start")
      },
      backend,
    })
    await updater.setMode("auto")
    await updater.check({ manual: true })

    const status = await updater.installAndRestart()

    expect(calls).toEqual(["stop", "start"])
    expect(status.phase).toBe("error")
    expect(status.error).toBe("installer unavailable")
  })

  test("tracks whether an update-controlled quit remains active", () => {
    const status = (phase: "idle" | "installing" | "error") =>
      ({ phase }) as Parameters<typeof desktopUpdateInstallActive>[1]
    expect(desktopUpdateInstallActive(false, status("installing"))).toBe(true)
    expect(desktopUpdateInstallActive(true, status("error"))).toBe(false)
    expect(desktopUpdateInstallActive(true, status("idle"))).toBe(true)
  })
})

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await Bun.sleep(1)
  }
  throw new Error("Timed out waiting for updater state")
}

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
