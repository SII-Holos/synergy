import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Config } from "../../src/config/config"
import { DaemonSpec } from "../../src/daemon/spec"

const originalEnv = { ...process.env }
const originalArgv = [...process.argv]

describe("daemon.spec", () => {
  let home: string

  beforeEach(async () => {
    home = path.join(os.tmpdir(), `synergy-daemon-spec-${Math.random().toString(36).slice(2)}`)
    process.env = { ...originalEnv, SYNERGY_TEST_HOME: home, PATH: "/usr/bin" }
    process.argv = [...originalArgv]
    await fs.mkdir(path.join(home, ".synergy", "config"), { recursive: true })
    Config.global.reset()
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
