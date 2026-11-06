import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { Daemon } from "../../src/daemon"
import { DaemonHealth } from "../../src/daemon/health"
import { DaemonState } from "@ericsanchezok/synergy-harness/util/daemon-state"
import { DaemonService } from "../../src/daemon/service"
import { Installation } from "@ericsanchezok/synergy-harness/global/installation"
import { afterAll as afterRuntimeTests } from "bun:test"
import { migrationFixture } from "@ericsanchezok/synergy-harness/test/migration/fixture"
const runtime = await migrationFixture()

function makeSpec(overrides?: Partial<Daemon.Spec>): Daemon.Spec {
  return {
    label: "dev.synergy.server",
    hostname: "127.0.0.1",
    port: 4096,
    url: "http://127.0.0.1:4096",
    command: ["synergy", "server", "--port", "4096"],
    cwd: "/tmp/test",
    env: { SYNERGY_DAEMON: "1" },
    logFile: "/tmp/test/daemon.log",
    connectHostname: "127.0.0.1",
    mdns: false,
    cors: [],
    ...overrides,
  }
}

function makeManifest(overrides?: Partial<DaemonState.Manifest>): DaemonState.Manifest {
  return {
    version: Installation.VERSION,
    label: "dev.synergy.server",
    manager: "launchd",
    hostname: "127.0.0.1",
    port: 4096,
    url: "http://127.0.0.1:4096",
    command: ["synergy", "server", "--port", "4096"],
    cwd: "/tmp/test",
    logFile: "/tmp/test/daemon.log",
    env: { SYNERGY_DAEMON: "1" },
    installedAt: Date.now(),
    ...overrides,
  }
}

function makeServiceStatus(overrides?: Partial<DaemonService.RuntimeStatus>): DaemonService.RuntimeStatus {
  return {
    installed: true,
    running: false,
    ...overrides,
  }
}

describe("computeObservedState", () => {
  test("prefers installed manifest spec for observation when config drifts", () =>
    runtime.run(() => {
      const desiredSpec = makeSpec({ port: 7777, url: "http://127.0.0.1:7777" })
      const manifest = makeManifest({
        port: 4096,
        url: "http://127.0.0.1:4096",
        logFile: "/tmp/test/installed.log",
      })

      const state = Daemon.computeObservedState({
        manager: "launchd",
        desiredSpec,
        manifest,
        serviceStatus: makeServiceStatus({ installed: true, running: true }),
        reachable: true,
        portListening: true,
      })

      expect(state.specSource).toBe("installed")
      expect(state.drifted).toBe(true)
      expect(state.desiredSpec.port).toBe(7777)
      expect(state.observedSpec.port).toBe(4096)
      expect(state.url).toBe("http://127.0.0.1:4096")
      expect(state.logFile).toBe("/tmp/test/installed.log")
    }))

  test("status reports failed when service manager says running but health is down", () =>
    runtime.run(() => {
      const spec = makeSpec()

      const state = Daemon.computeObservedState({
        manager: "launchd",
        desiredSpec: spec,
        manifest: undefined,
        serviceStatus: makeServiceStatus({
          installed: true,
          running: true,
          detail: "active but not responding",
        }),
        reachable: false,
        portListening: true,
      })

      expect(state.installed).toBe(true)
      expect(state.runtime).toBe("failed")
      expect(state.reachable).toBe(false)
      expect(state.portListening).toBe(true)
      expect(state.detail).toBe("active but not responding")
    }))

  test("status reports unknown when service is installed but manager and health disagree", () =>
    runtime.run(() => {
      const spec = makeSpec()

      const state = Daemon.computeObservedState({
        manager: "launchd",
        desiredSpec: spec,
        manifest: undefined,
        serviceStatus: makeServiceStatus({
          installed: true,
          running: false,
          detail: "inactive",
        }),
        reachable: false,
        portListening: true,
      })

      expect(state.installed).toBe(true)
      expect(state.runtime).toBe("unknown")
      expect(state.portListening).toBe(true)
      expect(state.reachable).toBe(false)
      expect(state.detail).toBe("inactive")
    }))

  test("uses desired spec when no manifest exists", () =>
    runtime.run(() => {
      const spec = makeSpec({ port: 9999, url: "http://127.0.0.1:9999" })

      const state = Daemon.computeObservedState({
        manager: "launchd",
        desiredSpec: spec,
        manifest: undefined,
        serviceStatus: makeServiceStatus({ installed: false, running: false }),
        reachable: false,
        portListening: false,
      })

      expect(state.specSource).toBe("desired")
      expect(state.drifted).toBe(false)
      expect(state.observedSpec.port).toBe(9999)
      expect(state.installed).toBe(false)
      expect(state.runtime).toBe("stopped")
      expect(state.detail).toBe("Service not installed")
    }))

  test("reports running when reachable", () =>
    runtime.run(() => {
      const spec = makeSpec()

      const state = Daemon.computeObservedState({
        manager: "launchd",
        desiredSpec: spec,
        manifest: undefined,
        serviceStatus: makeServiceStatus({ installed: true, running: true }),
        reachable: true,
        portListening: true,
      })

      expect(state.runtime).toBe("running")
      expect(state.reachable).toBe(true)
    }))

  test("reports stopped when not installed and nothing listening", () =>
    runtime.run(() => {
      const spec = makeSpec()

      const state = Daemon.computeObservedState({
        manager: "launchd",
        desiredSpec: spec,
        manifest: undefined,
        serviceStatus: makeServiceStatus({ installed: false, running: false }),
        reachable: false,
        portListening: false,
      })

      expect(state.runtime).toBe("stopped")
      expect(state.installed).toBe(false)
    }))

  test("reports unknown when not installed but port is listening", () =>
    runtime.run(() => {
      const spec = makeSpec()

      const state = Daemon.computeObservedState({
        manager: "launchd",
        desiredSpec: spec,
        manifest: undefined,
        serviceStatus: makeServiceStatus({ installed: false, running: false }),
        reachable: false,
        portListening: true,
      })

      expect(state.runtime).toBe("unknown")
    }))

  test("not drifted when manifest matches desired spec", () =>
    runtime.run(() => {
      const spec = makeSpec()
      const manifest = makeManifest()

      const state = Daemon.computeObservedState({
        manager: "launchd",
        desiredSpec: spec,
        manifest,
        serviceStatus: makeServiceStatus({ installed: true, running: true }),
        reachable: true,
        portListening: true,
      })

      expect(state.drifted).toBe(false)
      expect(state.specSource).toBe("installed")
    }))

  test("reports an older systemd service template as drifted after upgrade", () =>
    runtime.run(() => {
      const state = Daemon.computeObservedState({
        manager: "systemd-user",
        desiredSpec: makeSpec(),
        manifest: makeManifest({ manager: "systemd-user", version: "older-version" }),
        serviceStatus: makeServiceStatus({ installed: true, running: true }),
        reachable: true,
        portListening: true,
      })

      expect(state.drifted).toBe(true)
    }))

  test("keeps the current systemd service template installed", () =>
    runtime.run(() => {
      const state = Daemon.computeObservedState({
        manager: "systemd-user",
        desiredSpec: makeSpec(),
        manifest: makeManifest({ manager: "systemd-user" }),
        serviceStatus: makeServiceStatus({ installed: true, running: true }),
        reachable: true,
        portListening: true,
      })

      expect(state.drifted).toBe(false)
    }))
})

describe("normalizeRuntimeState", () => {
  test("not installed + nothing listening = stopped", () =>
    runtime.run(() => {
      expect(Daemon.normalizeRuntimeState({ installed: false, running: false }, false, false)).toBe("stopped")
    }))

  test("not installed + port listening = unknown", () =>
    runtime.run(() => {
      expect(Daemon.normalizeRuntimeState({ installed: false, running: false }, false, true)).toBe("unknown")
    }))

  test("not installed + reachable = unknown", () =>
    runtime.run(() => {
      expect(Daemon.normalizeRuntimeState({ installed: false, running: false }, true, false)).toBe("unknown")
    }))

  test("installed + reachable = running", () =>
    runtime.run(() => {
      expect(Daemon.normalizeRuntimeState({ installed: true, running: true }, true, true)).toBe("running")
    }))

  test("installed + running + not reachable = failed", () =>
    runtime.run(() => {
      expect(Daemon.normalizeRuntimeState({ installed: true, running: true }, false, false)).toBe("failed")
    }))

  test("installed + not running + port listening = unknown", () =>
    runtime.run(() => {
      expect(Daemon.normalizeRuntimeState({ installed: true, running: false }, false, true)).toBe("unknown")
    }))

  test("installed + not running + not listening = stopped", () =>
    runtime.run(() => {
      expect(Daemon.normalizeRuntimeState({ installed: true, running: false }, false, false)).toBe("stopped")
    }))
})

describe("normalizeStatusDetail", () => {
  test("not installed and no detail", () =>
    runtime.run(() => {
      expect(Daemon.normalizeStatusDetail({ installed: false, runtime: "stopped" })).toBe("Service not installed")
    }))

  test("installed + stopped and no detail", () =>
    runtime.run(() => {
      expect(Daemon.normalizeStatusDetail({ installed: true, runtime: "stopped" })).toBe(
        "Service installed but stopped",
      )
    }))

  test("installed + running and no detail", () =>
    runtime.run(() => {
      expect(Daemon.normalizeStatusDetail({ installed: true, runtime: "running" })).toBe(undefined)
    }))

  test("stopped + bad request detail normalizes", () =>
    runtime.run(() => {
      expect(Daemon.normalizeStatusDetail({ installed: true, runtime: "stopped", detail: "Bad request." })).toBe(
        "Service installed but stopped",
      )
    }))

  test("stopped + not installed detail when actually installed", () =>
    runtime.run(() => {
      expect(Daemon.normalizeStatusDetail({ installed: true, runtime: "stopped", detail: "not installed" })).toBe(
        "Service installed but stopped",
      )
    }))

  test("stopped + not installed detail when not installed", () =>
    runtime.run(() => {
      expect(Daemon.normalizeStatusDetail({ installed: false, runtime: "stopped", detail: "not installed" })).toBe(
        "Service not installed",
      )
    }))

  test("passes through custom detail", () =>
    runtime.run(() => {
      expect(Daemon.normalizeStatusDetail({ installed: true, runtime: "failed", detail: "custom error" })).toBe(
        "custom error",
      )
    }))
})

describe("daemon orchestration (integration)", () => {
  let runtime: Awaited<ReturnType<typeof migrationFixture>>
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
    runtime = await migrationFixture({ env: { SYNERGY_CONFIG_DIR: "/tmp/current-synergy-config" } })
    await runtime.run(async () => {
      originalResolve = DaemonService.resolve
      originalConfigGlobal = Config.global
      originalIsPortListening = DaemonHealth.isPortListening
      originalIsReachable = DaemonHealth.isReachable
    })
  })

  afterEach(() =>
    runtime.run(async () => {
      replaceServiceResolve(originalResolve)
      replaceConfigGlobal(originalConfigGlobal)
      replaceIsPortListening(originalIsPortListening)
      replaceIsReachable(originalIsReachable)
      await runtime.close()
    }),
  )

  test("start refreshes installed manifest when preserved service env changes", () =>
    runtime.run(async () => {
      stubConfigGlobal({
        server: {
          hostname: "127.0.0.1",
          port: 4096,
        },
      })

      {
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
      }
    }))

  test("stop uses installed manifest spec instead of drifted desired spec", () =>
    runtime.run(async () => {
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
        cwd: runtime.host.home,
        logFile: path.join(runtime.host.home, "installed.log"),
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
    }))
})

afterRuntimeTests(() => runtime.close())
