import { describe, expect, test } from "bun:test"
import {
  DISABLE_BUILTIN_MCP_ENV,
  builtinApiKeyHint,
  builtinServerStaged,
  collectBuiltinMcpServers,
} from "../../src/builtin-catalog"
import { afterAll } from "bun:test"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
const fixture = await runtimeHome()
afterAll(() => fixture[Symbol.asyncDispose]())

function withEnv<T>(disabled: boolean, fn: () => T): T {
  const owner = RuntimeContext.create({
    ...fixture.host,
    env: { ...fixture.host.env, [DISABLE_BUILTIN_MCP_ENV]: disabled ? "true" : undefined },
  })
  try {
    return owner.run(fn)
  } finally {
    owner.dispose()
  }
}

function names(servers: ReturnType<typeof collectBuiltinMcpServers>): string[] {
  return servers.map((server) => server.name).sort()
}

function find(servers: ReturnType<typeof collectBuiltinMcpServers>, name: string) {
  return servers.find((server) => server.name === name)
}

describe("collectBuiltinMcpServers", () => {
  test("returns nothing while the disable env is set (tests/CI)", () =>
    withEnv(true, () => {
      expect(collectBuiltinMcpServers(undefined)).toEqual([])
    }))

  test("stages anysearch + scholight remote servers when enabled", () =>
    withEnv(false, () => {
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
    }))

  test("a user typed entry for the same name overrides the builtin", () =>
    withEnv(false, () => {
      const servers = collectBuiltinMcpServers({
        anysearch: {
          type: "remote",
          url: "https://custom.example/mcp",
          startup: "manual",
        },
      })
      expect(names(servers)).toEqual(["scholight"])
    }))

  test("an explicit enabled:false stub opts the builtin out", () =>
    withEnv(false, () => {
      const servers = collectBuiltinMcpServers({
        scholight: { enabled: false },
      })
      expect(names(servers)).toEqual(["anysearch"])
    }))

  test("a bare enabled:true stub without a type does not own the name", () =>
    withEnv(false, () => {
      const servers = collectBuiltinMcpServers({
        anysearch: { enabled: true },
      })
      // Same semantics as the supervisor config loop: a stub without a type is
      // not a server, so the builtin remains active for that name.
      expect(names(servers)).toEqual(["anysearch", "scholight"])
    }))

  test("an apiKey stub does not own the name and injects a Bearer header", () =>
    withEnv(false, () => {
      const servers = collectBuiltinMcpServers({
        anysearch: { apiKey: "as_sk_test" },
      })
      expect(names(servers)).toEqual(["anysearch", "scholight"])

      const anysearch = find(servers, "anysearch")!
      expect(anysearch.config.type).toBe("remote")
      if (anysearch.config.type === "remote") {
        expect(anysearch.config.headers).toEqual({ Authorization: "Bearer as_sk_test" })
      }
    }))

  test("an empty apiKey string behaves like an absent key", () =>
    withEnv(false, () => {
      const servers = collectBuiltinMcpServers({
        anysearch: { apiKey: "" },
      })
      const anysearch = find(servers, "anysearch")!
      expect(anysearch.config.type).toBe("remote")
      if (anysearch.config.type === "remote") {
        expect(anysearch.config.headers).toBeUndefined()
      }
    }))

  test("an apiKey stub combines with an explicit opt-out marker", () =>
    withEnv(false, () => {
      const servers = collectBuiltinMcpServers({
        scholight: { enabled: false, apiKey: "sk_live_test" },
      })
      // enabled:false owns the name: the builtin is suppressed entirely, key
      // or not.
      expect(names(servers)).toEqual(["anysearch"])
    }))

  test("a malformed user value owns the name (no builtin shadowing)", () =>
    withEnv(false, () => {
      const servers = collectBuiltinMcpServers({
        anysearch: "https://custom.example/mcp",
      })
      expect(names(servers)).toEqual(["scholight"])
    }))

  test("builtinServerStaged reflects catalog ownership and the disable switch", () =>
    withEnv(false, () => {
      expect(builtinServerStaged("anysearch", undefined)).toBe(true)
      expect(builtinServerStaged("scholight", undefined)).toBe(true)
      expect(builtinServerStaged("github", undefined)).toBe(false)
      expect(
        builtinServerStaged("anysearch", { anysearch: { type: "remote", url: "https://custom.example/mcp" } }),
      ).toBe(false)
      expect(builtinServerStaged("scholight", { scholight: { enabled: false } })).toBe(false)
      expect(builtinServerStaged("anysearch", { anysearch: { apiKey: "as_sk_test" } })).toBe(true)
      expect(builtinServerStaged("anysearch", { anysearch: { expandByDefault: false } })).toBe(true)
      withEnv(true, () => expect(builtinServerStaged("anysearch", undefined)).toBe(false))
    }))
})

describe("builtinApiKeyHint", () => {
  test("masks all but the last four characters of a long key", () =>
    withEnv(false, () => {
      expect(builtinApiKeyHint({ apiKey: "fake-key-9876" })).toBe("••••9876")
    }))

  test("returns the bare mask for keys of eight characters or fewer", () =>
    withEnv(false, () => {
      expect(builtinApiKeyHint({ apiKey: "12345678" })).toBe("••••")
      expect(builtinApiKeyHint({ apiKey: "short" })).toBe("••••")
    }))

  test("returns undefined when no key is stored", () =>
    withEnv(false, () => {
      expect(builtinApiKeyHint(undefined)).toBeUndefined()
      expect(builtinApiKeyHint({})).toBeUndefined()
      // An empty apiKey is the clear marker and behaves like an absent key.
      expect(builtinApiKeyHint({ apiKey: "" })).toBeUndefined()
    }))

  test("returns undefined for non-object entries", () =>
    withEnv(false, () => {
      expect(builtinApiKeyHint(null)).toBeUndefined()
      expect(builtinApiKeyHint("sk_live_abcdefgh")).toBeUndefined()
      expect(builtinApiKeyHint(42)).toBeUndefined()
    }))
})
