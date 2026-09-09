import "../../src/configuration"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { DaemonSpec } from "@ericsanchezok/synergy-cli/daemon/spec"
import { ObservabilityStore } from "@ericsanchezok/synergy-harness/observability"
import { resetMigrations } from "@ericsanchezok/synergy-harness/migration"
import { parse as parseJsonc } from "jsonc-parser"
import { resolveNetworkOptions } from "@ericsanchezok/synergy-cli/cli/network"

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
    home = path.join(os.tmpdir(), `synergy-daemon-spec-${Math.random().toString(36).slice(2)}`)
    process.env = { ...originalEnv, SYNERGY_TEST_HOME: home, PATH: "/usr/bin" }
    process.argv = [...originalArgv]
    await fs.mkdir(path.join(home, ".synergy", "config"), { recursive: true })
    Config.global.reset()
    resetMigrations()
  })

  afterEach(async () => {
    await ObservabilityStore.close()
    process.env = { ...originalEnv }
    process.argv = [...originalArgv]
    Config.global.reset()
    await fs.rm(home, { recursive: true, force: true })
  })

  test("resolveNetwork migrates legacy channel holos config before reading config", async () => {
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
    expect(migrated.holos).toEqual({
      enabled: true,
      apiUrl: "https://www.holosai.io",
      wsUrl: "wss://www.holosai.io",
      portalUrl: "https://www.holosai.io",
    })
    expect(migrated.channel).toBeUndefined()
  })

  test("resolveNetwork removes legacy channel holos config when top-level holos already exists", async () => {
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
    expect(migrated.holos).toEqual({
      enabled: true,
      apiUrl: "https://api.holosai.io",
      wsUrl: "wss://api.holosai.io",
      portalUrl: "https://www.holosai.io",
    })
    expect(migrated.channel).toBeUndefined()
  })

  test("CLI network options migrate legacy identity config before reading config", async () => {
    const target = path.join(home, ".synergy", "config", "synergy.jsonc")
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
      }),
    )
    Config.global.reset()

    await expect(Config.global()).rejects.toThrow()

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
      autonomy: false,
    })
  })

  test("CLI network options remove deprecated Holos friend reply config before reading config", async () => {
    const target = path.join(home, ".synergy", "config", "synergy.jsonc")
    await Bun.write(
      target,
      JSON.stringify({
        holos_friend_reply_model: "openai/gpt-4.1-mini",
        server: {
          hostname: "0.0.0.0",
          port: 4321,
        },
      }),
    )
    Config.global.reset()

    await expect(Config.global()).rejects.toThrow()

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
  })
})
