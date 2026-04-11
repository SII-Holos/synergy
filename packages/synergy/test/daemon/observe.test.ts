import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Config } from "../../src/config/config"
import { Daemon } from "../../src/daemon"
import { DaemonHealth } from "../../src/daemon/health"
import { DaemonState } from "../../src/daemon/state"
import { DaemonService } from "../../src/daemon/service"

const originalTestHome = process.env.SYNERGY_TEST_HOME

describe("daemon.observe", () => {
  let home: string
  let originalResolve: typeof DaemonService.resolve
  let originalConfigGlobal: typeof Config.global
  let originalIsPortListening: typeof DaemonHealth.isPortListening
  let originalIsReachable: typeof DaemonHealth.isReachable

  function replaceConfigGlobal(value: typeof Config.global) {
    Object.defineProperty(Config, "global", { value, configurable: true })
  }

  function replaceServiceResolve(value: typeof DaemonService.resolve) {
    Object.defineProperty(DaemonService, "resolve", { value, configurable: true })
  }

  function replaceIsPortListening(value: typeof DaemonHealth.isPortListening) {
    Object.defineProperty(DaemonHealth, "isPortListening", { value, configurable: true })
  }

  function replaceIsReachable(value: typeof DaemonHealth.isReachable) {
    Object.defineProperty(DaemonHealth, "isReachable", { value, configurable: true })
  }

  function stubConfigGlobal(config: { server?: { hostname?: string; port?: number } }) {
    replaceConfigGlobal(Object.assign(async () => config, { reset() {} }) as typeof Config.global)
  }

  beforeEach(async () => {
    home = path.join(os.tmpdir(), `synergy-daemon-observe-${Math.random().toString(36).slice(2)}`)
    process.env.SYNERGY_TEST_HOME = home
    await fs.mkdir(home, { recursive: true })

    originalResolve = DaemonService.resolve
    originalConfigGlobal = Config.global
    originalIsPortListening = DaemonHealth.isPortListening
    originalIsReachable = DaemonHealth.isReachable
  })

  afterEach(async () => {
    replaceServiceResolve(originalResolve)
    replaceConfigGlobal(originalConfigGlobal)
    replaceIsPortListening(originalIsPortListening)
    replaceIsReachable(originalIsReachable)
    if (originalTestHome === undefined) delete process.env.SYNERGY_TEST_HOME
    else process.env.SYNERGY_TEST_HOME = originalTestHome
    await fs.rm(home, { recursive: true, force: true })
  })

  test("prefers installed manifest spec for observation when config drifts", async () => {
    stubConfigGlobal({
      server: {
        hostname: "127.0.0.1",
        port: 7777,
      },
    })

    await DaemonState.writeManifest({
      label: "dev.synergy.server",
      manager: "launchd",
      hostname: "127.0.0.1",
      port: 4096,
      url: "http://127.0.0.1:4096",
      command: ["synergy", "server", "--port", "4096"],
      cwd: home,
      logFile: path.join(home, "installed.log"),
      env: { SYNERGY_DAEMON: "1" },
    })

    let observedPort: number | undefined
    let observedUrl: string | undefined
    let observedStatusPort: number | undefined

    const service: DaemonService.Service = {
      manager: "launchd",
      install: async () => {},
      uninstall: async () => {},
      start: async () => {},
      stop: async () => {},
      restart: async () => {},
      status: async (spec) => {
        observedStatusPort = spec.port
        return {
          installed: true,
          running: true,
          detail: "ok",
        }
      },
    }

    replaceServiceResolve(async () => service)
    replaceIsPortListening(async (port) => {
      observedPort = port
      return true
    })
    replaceIsReachable(async (url) => {
      observedUrl = url
      return true
    })

    const state = await Daemon.observe()

    expect(state.specSource).toBe("installed")
    expect(state.drifted).toBe(true)
    expect(state.desiredSpec.port).toBe(7777)
    expect(state.observedSpec.port).toBe(4096)
    expect(state.url).toBe("http://127.0.0.1:4096")
    expect(state.logFile).toBe(path.join(home, "installed.log"))
    expect(observedStatusPort).toBe(4096)
    expect(observedPort).toBe(4096)
    expect(observedUrl).toBe("http://127.0.0.1:4096")
  })

  test("status reports failed when service manager says running but health is down", async () => {
    stubConfigGlobal({
      server: {
        hostname: "127.0.0.1",
        port: 4096,
      },
    })

    const service: DaemonService.Service = {
      manager: "launchd",
      install: async () => {},
      uninstall: async () => {},
      start: async () => {},
      stop: async () => {},
      restart: async () => {},
      status: async () => ({
        installed: true,
        running: true,
        detail: "active but not responding",
      }),
    }

    replaceServiceResolve(async () => service)
    replaceIsPortListening(async () => true)
    replaceIsReachable(async () => false)

    const state = await Daemon.observe()

    expect(state.installed).toBe(true)
    expect(state.runtime).toBe("failed")
    expect(state.reachable).toBe(false)
    expect(state.portListening).toBe(true)
    expect(state.detail).toBe("active but not responding")
  })

  test("status reports unknown when service is installed but manager and health disagree", async () => {
    stubConfigGlobal({
      server: {
        hostname: "127.0.0.1",
        port: 4096,
      },
    })

    const service: DaemonService.Service = {
      manager: "launchd",
      install: async () => {},
      uninstall: async () => {},
      start: async () => {},
      stop: async () => {},
      restart: async () => {},
      status: async () => ({
        installed: true,
        running: false,
        detail: "inactive",
      }),
    }

    replaceServiceResolve(async () => service)
    replaceIsPortListening(async () => true)
    replaceIsReachable(async () => false)

    const status = await Daemon.status()

    expect(status.installed).toBe(true)
    expect(status.runtime).toBe("unknown")
    expect(status.portListening).toBe(true)
    expect(status.reachable).toBe(false)
    expect(status.detail).toBe("inactive")
  })

  test("start refreshes installed manifest when preserved service env changes", async () => {
    stubConfigGlobal({
      server: {
        hostname: "127.0.0.1",
        port: 4096,
      },
    })

    const originalConfigDir = process.env.SYNERGY_CONFIG_DIR
    process.env.SYNERGY_CONFIG_DIR = "/tmp/current-synergy-config"

    try {
      const desiredSpec = await Daemon.buildSpec()
      await DaemonState.writeManifest({
        label: desiredSpec.label,
        manager: "launchd",
        hostname: desiredSpec.hostname,
        port: desiredSpec.port,
        url: desiredSpec.url,
        connectHostname: desiredSpec.connectHostname,
        mdns: desiredSpec.mdns,
        cors: desiredSpec.cors,
        command: desiredSpec.command,
        cwd: desiredSpec.cwd,
        logFile: desiredSpec.logFile,
        env: { ...desiredSpec.env, SYNERGY_CONFIG_DIR: "/tmp/previous-synergy-config" },
      })

      let installCount = 0
      let installedConfigDir: string | undefined
      const service: DaemonService.Service = {
        manager: "launchd",
        install: async (spec) => {
          installCount += 1
          installedConfigDir = spec.env.SYNERGY_CONFIG_DIR
        },
        uninstall: async () => {},
        start: async () => {},
        stop: async () => {},
        restart: async () => {},
        status: async () => ({
          installed: true,
          running: false,
          detail: "stopped",
        }),
      }

      replaceServiceResolve(async () => service)
      replaceIsPortListening(async () => false)
      replaceIsReachable(async () => false)

      await Daemon.start()

      const manifest = await DaemonState.readManifest()
      expect(installCount).toBe(1)
      expect(installedConfigDir).toBe("/tmp/current-synergy-config")
      expect(manifest?.env?.SYNERGY_CONFIG_DIR).toBe("/tmp/current-synergy-config")
    } finally {
      if (originalConfigDir === undefined) delete process.env.SYNERGY_CONFIG_DIR
      else process.env.SYNERGY_CONFIG_DIR = originalConfigDir
    }
  })

  test("stop uses installed manifest spec instead of drifted desired spec", async () => {
    stubConfigGlobal({
      server: {
        hostname: "127.0.0.1",
        port: 7777,
      },
    })

    await DaemonState.writeManifest({
      label: "dev.synergy.server",
      manager: "launchd",
      hostname: "127.0.0.1",
      port: 4096,
      url: "http://127.0.0.1:4096",
      command: ["synergy", "server", "--port", "4096"],
      cwd: home,
      logFile: path.join(home, "installed.log"),
      env: { SYNERGY_DAEMON: "1" },
    })

    let stoppedPort: number | undefined
    const service: DaemonService.Service = {
      manager: "launchd",
      install: async () => {},
      uninstall: async () => {},
      start: async () => {},
      stop: async (spec) => {
        stoppedPort = spec.port
      },
      restart: async () => {},
      status: async () => ({
        installed: true,
        running: false,
        detail: "stopped",
      }),
    }

    replaceServiceResolve(async () => service)
    replaceIsPortListening(async () => false)
    replaceIsReachable(async () => false)

    const result = await Daemon.stop()

    expect(stoppedPort).toBe(4096)
    expect(result.spec.port).toBe(4096)
    expect(result.state.specSource).toBe("installed")
    expect(result.state.observedSpec.port).toBe(4096)
  })
})
