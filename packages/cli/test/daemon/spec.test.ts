import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { DaemonSpec } from "../../src/daemon/spec"
import { migrationFixture } from "@ericsanchezok/synergy-harness/test/migration/fixture"
import { registerLocalRuntime } from "@ericsanchezok/synergy-runtime-local/register"
let runtime: Awaited<ReturnType<typeof migrationFixture>>
let home: string
const originalArgv = [...process.argv]
beforeEach(async () => {
  runtime = await migrationFixture({ register: registerLocalRuntime, env: { PATH: "/usr/bin" } })
  home = runtime.host.home
})
afterEach(async () => {
  process.argv = [...originalArgv]
  await runtime.close()
})

describe("daemon.spec", () => {
  test("managed services inherit their immutable Host environment and credentials", async () => {
    await using owner = await migrationFixture({
      register: registerLocalRuntime,
      env: {
        PATH: "/usr/bin",
        SYNERGY_BIN_PATH: "/custom/bin/synergy",
        SYNERGY_EMAIL_TOKEN: "secret",
        OPENAI_API_KEY: "secret",
        CUSTOM_PARENT_ENV: "present",
        SYNERGY_CONFIG_CONTENT: JSON.stringify({ server: { port: 5001 } }),
      },
    })
    const spec = await owner.run(() => DaemonSpec.resolve())
    expect(spec.env).toMatchObject({
      SYNERGY_DAEMON: "1",
      PATH: "/usr/bin",
      SYNERGY_BIN_PATH: "/custom/bin/synergy",
      SYNERGY_EMAIL_TOKEN: "secret",
      OPENAI_API_KEY: "secret",
      CUSTOM_PARENT_ENV: "present",
    })
    expect(spec.env.SYNERGY_CONFIG_CONTENT).toBe(JSON.stringify({ server: { port: 5001 } }))
    expect(spec.cwd).toBe(owner.host.home)
  })

  test("resolves managed-service network from config and preserves service fields", () =>
    runtime.run(async () => {
      await Bun.write(
        path.join(home, ".synergy", "config", "synergy.jsonc"),
        JSON.stringify({ server: { hostname: "0.0.0.0", port: 4321, mdns: true, cors: ["https://allowed.example"] } }),
      )
      Config.global.reset()

      const network = await DaemonSpec.resolveNetwork()
      expect(network.hostname).toBe("0.0.0.0")
      expect(network.connectHostname).toBe("127.0.0.1")
      expect(network.port).toBe(4321)
      expect(network.url).toBe("http://127.0.0.1:4321")
      expect(network.mdns).toBe(true)
      expect(network.cors).toEqual(["https://allowed.example"])
    }))

  test("prefers explicit argv for managed-service entry and keeps loopback url", () =>
    runtime.run(async () => {
      await Bun.write(
        path.join(home, ".synergy", "config", "synergy.jsonc"),
        JSON.stringify({
          server: { hostname: "127.0.0.1", port: 4321, mdns: false, cors: ["https://config.example"] },
        }),
      )
      Config.global.reset()

      const network = await DaemonSpec.resolveNetwork({
        argv: [
          "bun",
          "src/daemon/entry.ts",
          "--hostname",
          "0.0.0.0",
          "--port",
          "4500",
          "--mdns",
          "--cors",
          "https://argv.example",
        ],
      })

      expect(network.hostname).toBe("0.0.0.0")
      expect(network.connectHostname).toBe("127.0.0.1")
      expect(network.port).toBe(4500)
      expect(network.url).toBe("http://127.0.0.1:4500")
      expect(network.mdns).toBe(true)
      expect(network.cors).toEqual(["https://config.example", "https://argv.example"])
    }))

  test("another Host does not change an existing managed-service environment", async () => {
    await using first = await migrationFixture({
      register: registerLocalRuntime,
      env: { OPENAI_API_KEY: "first-token", UNRELATED_API_KEY: "also-passed" },
    })
    await using second = await migrationFixture({
      register: registerLocalRuntime,
      env: { OPENAI_API_KEY: "second-token" },
    })
    expect((await first.run(() => DaemonSpec.resolve())).env.OPENAI_API_KEY).toBe("first-token")
    expect((await second.run(() => DaemonSpec.resolve())).env.OPENAI_API_KEY).toBe("second-token")
    expect((await first.run(() => DaemonSpec.resolve())).env.UNRELATED_API_KEY).toBe("also-passed")
  })
})
