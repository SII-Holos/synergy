import { afterEach, describe, expect, test } from "bun:test"
import { DISABLE_BUILTIN_MCP_ENV, collectBuiltinMcpServers } from "../../src/mcp/builtin-catalog"

// test/preload.ts sets SYNERGY_DISABLE_BUILTIN_MCP=true so no test touches
// external endpoints; these tests toggle the env within this file's process
// and restore it afterwards.

const PRELOAD_VALUE = "true"

function names(servers: ReturnType<typeof collectBuiltinMcpServers>): string[] {
  return servers.map((server) => server.name).sort()
}

function find(servers: ReturnType<typeof collectBuiltinMcpServers>, name: string) {
  return servers.find((server) => server.name === name)
}

afterEach(() => {
  process.env[DISABLE_BUILTIN_MCP_ENV] = PRELOAD_VALUE
})

describe("collectBuiltinMcpServers", () => {
  test("returns nothing while the disable env is set (tests/CI)", () => {
    process.env[DISABLE_BUILTIN_MCP_ENV] = "true"
    expect(collectBuiltinMcpServers(undefined)).toEqual([])
  })

  test("stages anysearch + scholight remote servers when enabled", () => {
    delete process.env[DISABLE_BUILTIN_MCP_ENV]
    const servers = collectBuiltinMcpServers(undefined)
    expect(names(servers)).toEqual(["anysearch", "scholight"])

    const anysearch = find(servers, "anysearch")!
    expect(anysearch.config.type).toBe("remote")
    if (anysearch.config.type === "remote") {
      expect(anysearch.config.url).toBe("https://api.anysearch.com/mcp")
      expect(anysearch.config.oauth).toBe(false)
    }

    const scholight = find(servers, "scholight")!
    expect(scholight.config.type).toBe("remote")
    if (scholight.config.type === "remote") {
      expect(scholight.config.url).toBe("https://scholight.sanchezcloud.net/api/mcp")
      expect(scholight.config.oauth).toBe(false)
    }
  })

  test("a user typed entry for the same name overrides the builtin", () => {
    delete process.env[DISABLE_BUILTIN_MCP_ENV]
    const servers = collectBuiltinMcpServers({
      anysearch: {
        type: "remote",
        url: "https://custom.example/mcp",
        startup: "manual",
      },
    })
    expect(names(servers)).toEqual(["scholight"])
  })

  test("an explicit enabled:false stub opts the builtin out", () => {
    delete process.env[DISABLE_BUILTIN_MCP_ENV]
    const servers = collectBuiltinMcpServers({
      scholight: { enabled: false },
    })
    expect(names(servers)).toEqual(["anysearch"])
  })

  test("a bare enabled:true stub without a type does not own the name", () => {
    delete process.env[DISABLE_BUILTIN_MCP_ENV]
    const servers = collectBuiltinMcpServers({
      anysearch: { enabled: true },
    })
    // Same semantics as the supervisor config loop: a stub without a type is
    // not a server, so the builtin remains active for that name.
    expect(names(servers)).toEqual(["anysearch", "scholight"])
  })

  test("an apiKey stub does not own the name and injects a Bearer header", () => {
    delete process.env[DISABLE_BUILTIN_MCP_ENV]
    const servers = collectBuiltinMcpServers({
      anysearch: { apiKey: "as_sk_test" },
    })
    expect(names(servers)).toEqual(["anysearch", "scholight"])

    const anysearch = find(servers, "anysearch")!
    expect(anysearch.config.type).toBe("remote")
    if (anysearch.config.type === "remote") {
      expect(anysearch.config.headers).toEqual({ Authorization: "Bearer as_sk_test" })
    }
  })

  test("an empty apiKey string behaves like an absent key", () => {
    delete process.env[DISABLE_BUILTIN_MCP_ENV]
    const servers = collectBuiltinMcpServers({
      anysearch: { apiKey: "" },
    })
    const anysearch = find(servers, "anysearch")!
    expect(anysearch.config.type).toBe("remote")
    if (anysearch.config.type === "remote") {
      expect(anysearch.config.headers).toBeUndefined()
    }
  })

  test("an apiKey stub combines with an explicit opt-out marker", () => {
    delete process.env[DISABLE_BUILTIN_MCP_ENV]
    const servers = collectBuiltinMcpServers({
      scholight: { enabled: false, apiKey: "sk_live_test" },
    })
    // enabled:false owns the name: the builtin is suppressed entirely, key
    // or not.
    expect(names(servers)).toEqual(["anysearch"])
  })

  test("a malformed user value owns the name (no builtin shadowing)", () => {
    delete process.env[DISABLE_BUILTIN_MCP_ENV]
    const servers = collectBuiltinMcpServers({
      anysearch: "https://custom.example/mcp",
    })
    expect(names(servers)).toEqual(["scholight"])
  })
})
