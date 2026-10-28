import "../../src/configuration"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { DaemonSpec } from "@ericsanchezok/synergy-cli/daemon/spec"
import { ObservabilityStore } from "@ericsanchezok/synergy-harness/observability"
import { resetMigrations } from "@ericsanchezok/synergy-harness/migration"
import { parse as parseJsonc } from "jsonc-parser"
import { resolveNetworkOptions } from "@ericsanchezok/synergy-local-runtime/cli/network"
import { afterAll as afterRuntimeTests } from "bun:test"
import { compositionFixture } from "../support/composition"
let runtime: Awaited<ReturnType<typeof compositionFixture>>

const originalEnv = { ...process.env }
const originalArgv = [...process.argv]

async function readMigratedLegacyConfig(filepath: string) {
  const direct = Bun.file(filepath)
  if (await direct.exists()) return parseJsonc(await direct.text()) as Record<string, any>

  const archived = Bun.file(path.join(path.dirname(filepath), "archive", path.basename(filepath)))
  return parseJsonc(await archived.text()) as Record<string, any>
}

describe("daemon.spec", () => {
  let home: string

  beforeEach(async () => {
    runtime = await compositionFixture({ env: { PATH: "/usr/bin" } })
    home = runtime.host.home
    process.argv = [...originalArgv]
    await fs.mkdir(path.join(home, ".synergy", "config"), { recursive: true })
  })

  afterEach(async () => {
    process.argv = [...originalArgv]
    await runtime.close()
  })

  test("resolveNetwork retires legacy channel identity config before reading config", () =>
    runtime.run(async () => {
      const target = path.join(home, ".synergy", "config", "synergy.jsonc")
      await Bun.write(
        target,
        `{
  "channel": {
    "holos": {
      "type": "holos",
      "apiUrl": "https://www.holosai.io",
      "wsUrl": "wss://www.holosai.io",
      "portalUrl": "https://www.holosai.io",
      "accounts": {
        "default": {
          "enabled": true
        }
      }
    }
  },
  "server": {
    "hostname": "0.0.0.0",
    "port": 4321
  }
}`,
      )
      Config.global.reset()

      const network = await DaemonSpec.resolveNetwork()
      expect(network.hostname).toBe("0.0.0.0")
      expect(network.port).toBe(4321)

      const migrated = await readMigratedLegacyConfig(target)
      expect(migrated.holos).toBeUndefined()
      expect(migrated.channel).toBeUndefined()
    }))

  test("resolveNetwork removes legacy channel holos config when top-level holos already exists", () =>
    runtime.run(async () => {
      const target = path.join(home, ".synergy", "config", "synergy.jsonc")
      await Bun.write(
        target,
        `{
  "channel": {
    "holos": {
      "type": "holos",
      "apiUrl": "https://www.holosai.io",
      "wsUrl": "wss://www.holosai.io",
      "portalUrl": "https://www.holosai.io",
      "accounts": {
        "default": {
          "enabled": true
        }
      }
    }
  },
  "holos": {
    "enabled": true,
    "apiUrl": "https://api.holosai.io",
    "wsUrl": "wss://api.holosai.io",
    "portalUrl": "https://www.holosai.io"
  },
  "server": {
    "port": 4321
  }
}`,
      )
      Config.global.reset()

      const network = await DaemonSpec.resolveNetwork()
      expect(network.port).toBe(4321)

      const migrated = await readMigratedLegacyConfig(target)
      expect(migrated.holos).toBeUndefined()
      expect(migrated.channel).toBeUndefined()
    }))

  test("CLI network options migrate legacy identity config before reading config", () =>
    runtime.run(async () => {
      const target = path.join(home, ".synergy", "config", "synergy.jsonc")
      const retained = { entries: ["future", { checkpoint: 3 }] }
      await Bun.write(
        target,
        JSON.stringify({
          identity: {
            evolution: {
              active: {
                retrieve: false,
              },
              passive: false,
            },
            autonomy: false,
          },
          server: {
            hostname: "0.0.0.0",
            port: 4321,
          },
          unregisteredOwner: retained,
        }),
      )
      Config.global.reset()

      const visible = await Config.global()
      expect(visible).not.toHaveProperty("identity")
      expect(visible).not.toHaveProperty("unregisteredOwner")
      expect((await readMigratedLegacyConfig(target)).unregisteredOwner).toEqual(retained)

      const network = await resolveNetworkOptions({
        hostname: "0.0.0.0",
        port: 0,
        mdns: false,
        cors: [],
      })
      expect(network.hostname).toBe("0.0.0.0")
      expect(network.port).toBe(4321)

      const migrated = await readMigratedLegacyConfig(target)
      expect(migrated.identity).toBeUndefined()
      expect(migrated.library).toEqual({
        memory: {
          enabled: false,
        },
        experience: {
          encode: false,
          retrieve: false,
        },
      })
      expect(migrated.anima).toEqual({ enabled: false })
      expect(migrated.unregisteredOwner).toEqual(retained)
    }))

  test("CLI network options remove deprecated Holos friend reply config before reading config", () =>
    runtime.run(async () => {
      const target = path.join(home, ".synergy", "config", "synergy.jsonc")
      const retained = { entries: ["future", { checkpoint: 3 }] }
      await Bun.write(
        target,
        JSON.stringify({
          holos_friend_reply_model: "openai/gpt-4.1-mini",
          server: {
            hostname: "0.0.0.0",
            port: 4321,
          },
          unregisteredOwner: retained,
        }),
      )
      Config.global.reset()

      const visible = await Config.global()
      expect(visible).not.toHaveProperty("holos_friend_reply_model")
      expect(visible).not.toHaveProperty("unregisteredOwner")
      expect((await readMigratedLegacyConfig(target)).unregisteredOwner).toEqual(retained)

      const network = await resolveNetworkOptions({
        hostname: "0.0.0.0",
        port: 0,
        mdns: false,
        cors: [],
      })
      expect(network.hostname).toBe("0.0.0.0")
      expect(network.port).toBe(4321)

      const migrated = await readMigratedLegacyConfig(target)
      expect(migrated.holos_friend_reply_model).toBeUndefined()
      expect(migrated.server).toEqual({
        hostname: "0.0.0.0",
        port: 4321,
      })
      expect(migrated.unregisteredOwner).toEqual(retained)
    }))
})
