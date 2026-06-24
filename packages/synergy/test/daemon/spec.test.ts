import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Config } from "../../src/config/config"
import { DaemonSpec } from "../../src/daemon/spec"
import { resetMigrations } from "../../src/migration"
import { parse as parseJsonc } from "jsonc-parser"
import { resolveNetworkOptions } from "../../src/cli/network"

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
    process.env = { ...originalEnv }
    process.argv = [...originalArgv]
    Config.global.reset()
    await fs.rm(home, { recursive: true, force: true })
  })

  test("inherits a full parent-process environment snapshot for managed services", async () => {
    process.env.SYNERGY_CONFIG_DIR = "/tmp/custom-synergy-config"
    process.env.SYNERGY_CONFIG_CONTENT = JSON.stringify({ server: { port: 5001 } })
    process.env.SYNERGY_BIN_PATH = "/custom/bin/synergy"
    process.env.SYNERGY_EMAIL_TOKEN = "secret"
    process.env.OPENAI_API_KEY = "secret"
    process.env.CUSTOM_PARENT_ENV = "present"

    const spec = await DaemonSpec.resolve()

    expect(spec.env.SYNERGY_DAEMON).toBe("1")
    expect(spec.env.PATH).toBe("/usr/bin")
    expect(spec.env.SYNERGY_CONFIG_DIR).toBe("/tmp/custom-synergy-config")
    expect(spec.env.SYNERGY_CONFIG_CONTENT).toBe(JSON.stringify({ server: { port: 5001 } }))
    expect(spec.env.SYNERGY_BIN_PATH).toBe("/custom/bin/synergy")
    expect(spec.env.SYNERGY_EMAIL_TOKEN).toBe("secret")
    expect(spec.env.OPENAI_API_KEY).toBe("secret")
    expect(spec.env.CUSTOM_PARENT_ENV).toBe("present")
  })

  test("resolves managed-service network from config and preserves service fields", async () => {
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
  })

  test("prefers explicit argv for managed-service entry and keeps loopback url", async () => {
    await Bun.write(
      path.join(home, ".synergy", "config", "synergy.jsonc"),
      JSON.stringify({ server: { hostname: "127.0.0.1", port: 4321, mdns: false, cors: ["https://config.example"] } }),
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
    expect(migrated.engram).toEqual({
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

  test("inherits provider credentials without requiring config env declarations", async () => {
    process.env.SII_API_KEY = "provider-token"
    process.env.UNRELATED_API_KEY = "also-passed"

    await Bun.write(
      path.join(home, ".synergy", "config", "synergy.jsonc"),
      JSON.stringify({
        provider: {
          "sii-openai": {
            env: ["SII_API_KEY"],
          },
        },
      }),
    )
    Config.global.reset()

    const spec = await DaemonSpec.resolve()
    expect(spec.env.SII_API_KEY).toBe("provider-token")
    expect(spec.env.UNRELATED_API_KEY).toBe("also-passed")
  })

  test("captures the current process env each time the managed-service spec is resolved", async () => {
    process.env.OPENAI_API_KEY = "first-token"
    const first = await DaemonSpec.resolve()

    process.env.OPENAI_API_KEY = "second-token"
    const second = await DaemonSpec.resolve()

    expect(first.env.OPENAI_API_KEY).toBe("first-token")
    expect(second.env.OPENAI_API_KEY).toBe("second-token")
  })
})
