import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { DaemonCommand } from "../../src/daemon/command"

const originalEnv = { ...process.env }
const originalExecPath = process.execPath
const originalArgv = [...process.argv]

describe("daemon.command", () => {
  afterEach(() => {
    process.env = { ...originalEnv }
    Object.defineProperty(process, "execPath", { value: originalExecPath })
    process.argv = [...originalArgv]
  })

  test("uses explicit binary path when provided", () => {
    process.env.SYNERGY_BIN_PATH = "/custom/bin/synergy"
    const spec = DaemonCommand.resolve({ hostname: "127.0.0.1", port: 4096 })
    expect(spec.cmd[0]).toBe("/custom/bin/synergy")
    expect(spec.cmd).toContain("--managed-service")
    expect(spec.cmd).toContain("4096")
  })

  test("uses current executable when already running as synergy binary", () => {
    Object.defineProperty(process, "execPath", { value: "/usr/local/bin/synergy" })
    const spec = DaemonCommand.resolve({ hostname: "127.0.0.1", port: 4096 })
    expect(spec.cmd[0]).toBe("/usr/local/bin/synergy")
    expect(spec.cmd[1]).toBe("server")
  })

  test("uses local TypeScript daemon entrypoint in local development", () => {
    delete process.env.SYNERGY_BIN_PATH
    Object.defineProperty(process, "execPath", { value: "/opt/homebrew/bin/bun" })
    const spec = DaemonCommand.resolve({ hostname: "127.0.0.1", port: 4096 })
    expect(spec.cmd[0]).toBe("/opt/homebrew/bin/bun")
    expect(spec.cmd[1]).toBe("run")
    expect(spec.cmd).toContain("src/daemon/entry.ts")
  })

  test("preserves managed-service runtime env vars and excludes launcher-only client context", () => {
    process.env.PATH = "/usr/bin"
    process.env.SYNERGY_CWD = "/workspace"
    process.env.SYNERGY_CONFIG_DIR = "/workspace/.synergy"
    process.env.SYNERGY_PERMISSION = '{"bash":"allow"}'
    process.env.SYNERGY_DISABLE_PRUNE = "1"
    process.env.SYNERGY_EXPERIMENTAL = "1"
    process.env.SYNERGY_EXPERIMENTAL_LSP_TOOL = "true"
    process.env.SYNERGY_SEARXNG_URL = "https://search.example"
    process.env.SYNERGY_BIN_PATH = "/custom/bin/synergy"
    process.env.SYNERGY_CLIENT = "web"
    process.env.SYNERGY_CALLER = "vscode"
    process.env.SYNERGY_EMAIL_TOKEN = "secret"
    process.env.SYNERGY_EMBEDDING_KEY = "secret"
    process.env.OPENAI_API_KEY = "secret"

    const spec = DaemonCommand.resolve({ hostname: "127.0.0.1", port: 4096 })

    expect(spec.env.SYNERGY_DAEMON).toBe("1")
    expect(spec.env.PATH).toBe("/usr/bin")
    expect(spec.env.SYNERGY_CWD).toBe("/workspace")
    expect(spec.env.SYNERGY_CONFIG_DIR).toBe("/workspace/.synergy")
    expect(spec.env.SYNERGY_PERMISSION).toBe('{"bash":"allow"}')
    expect(spec.env.SYNERGY_DISABLE_PRUNE).toBe("1")
    expect(spec.env.SYNERGY_EXPERIMENTAL).toBe("1")
    expect(spec.env.SYNERGY_EXPERIMENTAL_LSP_TOOL).toBe("true")
    expect(spec.env.SYNERGY_SEARXNG_URL).toBe("https://search.example")
    expect(spec.env.SYNERGY_BIN_PATH).toBe("/custom/bin/synergy")
    expect(spec.env.SYNERGY_CLIENT).toBeUndefined()
    expect(spec.env.SYNERGY_CALLER).toBeUndefined()
    expect(spec.env.SYNERGY_EMAIL_TOKEN).toBe("secret")
    expect(spec.env.SYNERGY_EMBEDDING_KEY).toBe("secret")
    expect(spec.env.OPENAI_API_KEY).toBe("secret")
  })

  test("shellQuote escapes spaces and quotes", () => {
    const quoted = DaemonCommand.shellQuote(["simple", "/tmp/with space", "it's"])
    expect(quoted).toBe("simple '/tmp/with space' 'it'\"'\"'s'")
  })

  test("log path is placed under daemon state directory", () => {
    const logFile = DaemonCommand.logPath()
    expect(path.basename(logFile)).toBe("server.log")
  })

  test("uses a stable platform-specific service label", () => {
    const expected =
      process.platform === "linux" ? "synergy" : process.platform === "win32" ? "Synergy" : "dev.synergy.server"
    expect(DaemonCommand.serviceLabel()).toBe(expected)
  })
})
