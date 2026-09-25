import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Hono } from "hono"
import { DaemonState } from "@ericsanchezok/synergy-harness/util/daemon-state"
import { DaemonPaths } from "@ericsanchezok/synergy-harness/util/daemon-paths"
import { resolveControlCommand, setServerUpdateWorkerControlsForTest, UpdateRoute } from "../../src/server/update-route"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
let runtime: Awaited<ReturnType<typeof testRuntime>>

const originalEnv = { ...process.env }

describe("server update route", () => {
  let home: string
  let spawned: string[][]

  beforeEach(async () => {
    runtime = await testRuntime({ SYNERGY_DAEMON: "1" })
    home = runtime.host.home
    spawned = []
    runtime.run(() =>
      setServerUpdateWorkerControlsForTest({
        latestVersion: async () => "999.0.0",
        installMethod: async () => "npm",
        spawn(command) {
          spawned.push(command)
        },
      }),
    )
  })
  afterEach(() => runtime.close())

  test("reports remote capability for non-localhost requests", () =>
    runtime.run(async () => {
      const app = testApp()
      const response = await app.request(
        new Request("http://example.com/global/update/status", { headers: { host: "example.com" } }),
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.capability).toBe("remote")
      expect(body.progress).toBe(null)
    }))

  test("reports not-managed for terminal-run servers", () =>
    runtime.run(async () => {
      await writeManifest(["/usr/local/bin/synergy", "server", "--port", "4096"])
      await using terminal = await testRuntime({ SYNERGY_DAEMON: undefined })
      await terminal.run(async () => {
        const app = testApp()
        const response = await app.request("/global/update/status")

        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body.capability).toBe("not-managed")
        expect(body.updateAvailable).toBe(false)
        expect(body.progress).toBe(null)
      })
    }))

  test("checks managed daemon updates only on localhost", () =>
    runtime.run(async () => {
      await writeManifest(["/usr/local/bin/synergy", "server", "--port", "4096"])

      const app = testApp()
      const remote = await app.request(new Request("http://example.com/global/update/check", { method: "POST" }))
      expect(remote.status).toBe(403)

      const local = await app.request("/global/update/check", { method: "POST" })
      expect(local.status).toBe(200)
      const body = await local.json()
      expect(body.capability).toBe("managed")
      expect(body.phase).toBe("available")
      expect(body.latestVersion).toBe("999.0.0")
      expect(body.progress).toBe(0)
    }))

  test("dispatches a detached worker for managed daemon updates", () =>
    runtime.run(async () => {
      await writeManifest(["/usr/local/bin/synergy", "server", "--port", "4096"])

      const app = testApp()
      const response = await app.request("/global/update/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: "999.0.0" }),
      })

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.capability).toBe("managed")
      expect(body.phase).toBe("updating")
      expect(body.progress).toBe(5)
      expect(spawned).toEqual([
        process.platform === "win32"
          ? ["cmd.exe", "/c", path.join(DaemonPaths.root(), "update-worker.cmd")]
          : ["sh", path.join(DaemonPaths.root(), "update-worker.sh")],
      ])

      const state = await Bun.file(path.join(DaemonPaths.root(), "update-state.json")).json()
      expect(state.phase).toBe("updating")
      expect(state.latestVersion).toBe("999.0.0")
      expect(state.progress).toBe(5)
      const script = await Bun.file(
        path.join(DaemonPaths.root(), process.platform === "win32" ? "update-worker.cmd" : "update-worker.sh"),
      ).text()
      expect(script).toContain("npm")
      expect(script).toContain("install")
      expect(script).toContain("-g")
      expect(script).toContain("--no-audit")
      expect(script).toContain("--no-fund")
      expect(script).toContain("@ericsanchezok/synergy@999.0.0")
      expect(script).toContain("--registry=https://registry.npmjs.org")
      expect(script).toContain("stop")
      expect(script).toContain("start")
    }))

  test.each(["999.0.0&calc", "999.0.0; touch /tmp/pwned", "999.0.0 > escaped", "999.0.0'bad"])(
    "rejects unsafe managed update version %s before creating a worker",
    async (version) =>
      runtime.run(async () => {
        await writeManifest(["/usr/local/bin/synergy", "server", "--port", "4096"])

        const app = testApp()
        const response = await app.request("/global/update/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version }),
        })

        expect(response.status).toBe(400)
        const body = await response.json()
        expect(body.phase).toBe("error")
        expect(body.error).toContain("Invalid Synergy version")
        expect(spawned).toEqual([])
        expect(await Bun.file(path.join(DaemonPaths.root(), "update-state.json")).exists()).toBe(false)
        expect(
          await Bun.file(
            path.join(DaemonPaths.root(), process.platform === "win32" ? "update-worker.cmd" : "update-worker.sh"),
          ).exists(),
        ).toBe(false)
      }),
  )

  test("allows safe prerelease versions for managed updates", () =>
    runtime.run(async () => {
      await writeManifest(["/usr/local/bin/synergy", "server", "--port", "4096"])

      const app = testApp()
      const response = await app.request("/global/update/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: "999.0.0-beta.1" }),
      })

      expect(response.status).toBe(200)
      expect(spawned).toHaveLength(1)
    }))

  test("uses the detected package manager for managed daemon updates", () =>
    runtime.run(async () => {
      await writeManifest(["/usr/local/bin/synergy", "server", "--port", "4096"])
      setServerUpdateWorkerControlsForTest({
        latestVersion: async () => "999.0.0",
        installMethod: async () => "pnpm",
        spawn(command) {
          spawned.push(command)
        },
      })

      const app = testApp()
      const response = await app.request("/global/update/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: "999.0.0" }),
      })

      expect(response.status).toBe(200)
      const script = await Bun.file(
        path.join(DaemonPaths.root(), process.platform === "win32" ? "update-worker.cmd" : "update-worker.sh"),
      ).text()
      expect(script).toContain("pnpm")
      expect(script).toContain("@ericsanchezok/synergy@999.0.0")
      expect(script).toContain("--registry=https://registry.npmjs.org")
    }))

  test.each(["unknown", "standalone"] as const)(
    "does not offer managed daemon updates for %s install methods",
    (installMethod) =>
      runtime.run(async () => {
        await writeManifest(["/usr/local/bin/synergy", "server", "--port", "4096"])
        setServerUpdateWorkerControlsForTest({
          latestVersion: async () => "999.0.0",
          installMethod: async () => installMethod,
          spawn(command) {
            spawned.push(command)
          },
        })

        const app = testApp()
        const response = await app.request("/global/update/check", { method: "POST" })

        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body.capability).toBe("managed")
        expect(body.phase).toBe("error")
        expect(body.updateAvailable).toBe(true)
        expect(body.error).toBe("Managed service install method cannot be updated from Web.")
        expect(spawned).toEqual([])
      }),
  )

  test("reports Desktop-managed updater guidance for desktop install methods", () =>
    runtime.run(async () => {
      await writeManifest([
        "/Applications/Synergy.app/Contents/Resources/synergy/bin/synergy",
        "server",
        "--port",
        "4096",
      ])
      setServerUpdateWorkerControlsForTest({
        latestVersion: async () => "999.0.0",
        installMethod: async () => "desktop",
        spawn(command) {
          spawned.push(command)
        },
      })

      const app = testApp()
      const response = await app.request("/global/update/check", { method: "POST" })

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.capability).toBe("managed")
      expect(body.phase).toBe("error")
      expect(body.updateAvailable).toBe(true)
      expect(body.error).toBe("This service uses the Synergy Desktop runtime. Update it from the Desktop app.")
      expect(spawned).toEqual([])
    }))

  test.each(["unknown", "standalone"] as const)(
    "does not start a worker for %s managed install methods",
    (installMethod) =>
      runtime.run(async () => {
        await writeManifest(["/usr/local/bin/synergy", "server", "--port", "4096"])
        setServerUpdateWorkerControlsForTest({
          latestVersion: async () => "999.0.0",
          installMethod: async () => installMethod,
          spawn(command) {
            spawned.push(command)
          },
        })

        const app = testApp()
        const response = await app.request("/global/update/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: "999.0.0" }),
        })

        expect(response.status).toBe(400)
        const body = await response.json()
        expect(body.phase).toBe("error")
        expect(body.error).toBe("Managed service install method cannot be updated from Web.")
        expect(spawned).toEqual([])
      }),
  )

  test("does not start a worker for Desktop-managed install methods", () =>
    runtime.run(async () => {
      await writeManifest([
        "/Applications/Synergy.app/Contents/Resources/synergy/bin/synergy",
        "server",
        "--port",
        "4096",
      ])
      setServerUpdateWorkerControlsForTest({
        latestVersion: async () => "999.0.0",
        installMethod: async () => "desktop",
        spawn(command) {
          spawned.push(command)
        },
      })

      const app = testApp()
      const response = await app.request("/global/update/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: "999.0.0" }),
      })

      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.phase).toBe("error")
      expect(body.error).toBe("This service uses the Synergy Desktop runtime. Update it from the Desktop app.")
      expect(spawned).toEqual([])
    }))

  test("does not start a worker for dev-only daemon commands", () =>
    runtime.run(async () => {
      await writeManifest(["bun", "run", "--cwd", "/repo/packages/presets", "src/daemon-entry.ts", "--port", "4096"])

      const app = testApp()
      const response = await app.request("/global/update/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: "999.0.0" }),
      })

      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.capability).toBe("managed")
      expect(body.phase).toBe("error")
      expect(spawned).toEqual([])
    }))

  test("resolves stable service command prefixes for update orchestration", () =>
    runtime.run(() => {
      expect(resolveControlCommand(["/usr/local/bin/synergy", "server", "--port", "4096"])).toEqual([
        "/usr/local/bin/synergy",
      ])
      expect(resolveControlCommand(["/usr/bin/bun", "/pkg/bin/synergy", "server", "--port", "4096"])).toEqual([
        "/usr/bin/bun",
        "/pkg/bin/synergy",
      ])
      expect(resolveControlCommand(["bun", "run", "src/daemon/entry.ts"])).toBeUndefined()
    }))
})

function testApp() {
  return new Hono().route("/global/update", UpdateRoute())
}

async function writeManifest(command: string[]) {
  await DaemonState.writeManifest({
    label: "dev.synergy.server",
    manager: "launchd",
    hostname: "127.0.0.1",
    port: 4096,
    url: "http://127.0.0.1:4096",
    connectHostname: "127.0.0.1",
    command,
    cwd: homeDirectory(),
    logFile: DaemonPaths.logFile(),
    env: { SYNERGY_DAEMON: "1" },
  })
}

function homeDirectory() {
  return runtime.host.home
}
