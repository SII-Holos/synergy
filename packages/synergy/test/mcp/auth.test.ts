import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import { McpAuth } from "../../src/mcp/auth"
import { Global } from "../../src/global"
import { Log } from "../../src/util/log"

Log.init({ print: false })

describe("McpAuth", () => {
  let backup: string | undefined

  beforeEach(async () => {
    McpAuth.invalidateCache()
    const file = Bun.file(Global.Path.authMcp)
    const exists = await file.exists()
    backup = exists ? await file.text() : undefined
    await fs.mkdir(new URL("..", `file://${Global.Path.authMcp}`).pathname, { recursive: true }).catch(() => {})
    await Bun.write(Global.Path.authMcp, "{}")
  })

  afterEach(async () => {
    if (backup !== undefined) {
      await Bun.write(Global.Path.authMcp, backup)
    } else {
      await Bun.write(Global.Path.authMcp, "{}")
    }
  })

  describe("all()", () => {
    test("returns empty object when auth file is empty", async () => {
      const result = await McpAuth.all()
      expect(result).toEqual({})
    })

    test("returns stored entries", async () => {
      await Bun.write(
        Global.Path.authMcp,
        JSON.stringify(
          {
            "my-server": {
              tokens: {
                accessToken: "abc123",
                refreshToken: "refresh456",
                expiresAt: 9999999999,
                scope: "read write",
              },
            },
          },
          null,
          2,
        ),
      )

      const result = await McpAuth.all()
      expect(result["my-server"].tokens?.accessToken).toBe("abc123")
      expect(result["my-server"].tokens?.refreshToken).toBe("refresh456")
    })
  })

  describe("get()", () => {
    test("returns undefined for unknown mcpName", async () => {
      const result = await McpAuth.get("nonexistent")
      expect(result).toBeUndefined()
    })

    test("returns entry for known mcpName", async () => {
      await McpAuth.set("test-server", {
        tokens: { accessToken: "tok" },
      })

      const result = await McpAuth.get("test-server")
      expect(result).toBeDefined()
      expect(result!.tokens!.accessToken).toBe("tok")
    })
  })

  describe("getForUrl()", () => {
    test("returns undefined if entry has no serverUrl", async () => {
      await McpAuth.set("test-server", {
        tokens: { accessToken: "tok" },
      })

      const result = await McpAuth.getForUrl("test-server", "https://example.com")
      expect(result).toBeUndefined()
    })

    test("returns undefined if serverUrl does not match", async () => {
      await McpAuth.set(
        "test-server",
        {
          tokens: { accessToken: "tok" },
        },
        "https://original.com",
      )

      const result = await McpAuth.getForUrl("test-server", "https://different.com")
      expect(result).toBeUndefined()
    })

    test("returns entry if serverUrl matches", async () => {
      await McpAuth.set(
        "test-server",
        {
          tokens: { accessToken: "tok" },
        },
        "https://example.com",
      )

      const result = await McpAuth.getForUrl("test-server", "https://example.com")
      expect(result).toBeDefined()
      expect(result!.tokens!.accessToken).toBe("tok")
    })

    test("returns undefined for unknown mcpName", async () => {
      const result = await McpAuth.getForUrl("nonexistent", "https://example.com")
      expect(result).toBeUndefined()
    })
  })

  describe("set()", () => {
    test("creates a new entry", async () => {
      await McpAuth.set("new-server", {
        tokens: { accessToken: "new-tok" },
      })

      const entry = await McpAuth.get("new-server")
      expect(entry).toBeDefined()
      expect(entry!.tokens!.accessToken).toBe("new-tok")
    })

    test("updates existing entry", async () => {
      await McpAuth.set("server", { tokens: { accessToken: "old" } })
      await McpAuth.set("server", { tokens: { accessToken: "new" } })

      const entry = await McpAuth.get("server")
      expect(entry!.tokens!.accessToken).toBe("new")
    })

    test("stores serverUrl when provided", async () => {
      await McpAuth.set("server", { tokens: { accessToken: "tok" } }, "https://example.com")

      const entry = await McpAuth.get("server")
      expect(entry!.serverUrl).toBe("https://example.com")
    })

    test("overwrites serverUrl when entry is replaced without serverUrl", async () => {
      await McpAuth.set("server", { tokens: { accessToken: "tok" } }, "https://example.com")
      await McpAuth.set("server", { tokens: { accessToken: "tok2" } })

      const entry = await McpAuth.get("server")
      expect(entry!.serverUrl).toBeUndefined()
      expect(entry!.tokens!.accessToken).toBe("tok2")
    })

    test("sets file permissions to 0o600", async () => {
      await McpAuth.set("server", { tokens: { accessToken: "tok" } })

      const stat = await fs.stat(Global.Path.authMcp)
      const mode = stat.mode & 0o777
      expect(mode).toBe(0o600)
    })
  })

  describe("remove()", () => {
    test("removes an existing entry", async () => {
      await McpAuth.set("server-a", { tokens: { accessToken: "a" } })
      await McpAuth.set("server-b", { tokens: { accessToken: "b" } })

      await McpAuth.remove("server-a")

      expect(await McpAuth.get("server-a")).toBeUndefined()
      const entryB = await McpAuth.get("server-b")
      expect(entryB!.tokens!.accessToken).toBe("b")
    })

    test("does nothing for nonexistent entry", async () => {
      await McpAuth.set("server-a", { tokens: { accessToken: "a" } })

      await McpAuth.remove("nonexistent")

      const entryA = await McpAuth.get("server-a")
      expect(entryA!.tokens!.accessToken).toBe("a")
    })
  })

  describe("updateTokens()", () => {
    test("creates entry if none exists", async () => {
      await McpAuth.updateTokens("server", {
        accessToken: "new-tok",
        refreshToken: "new-refresh",
      })

      const entry = await McpAuth.get("server")
      expect(entry).toBeDefined()
      expect(entry!.tokens!.accessToken).toBe("new-tok")
      expect(entry!.tokens!.refreshToken).toBe("new-refresh")
    })

    test("updates tokens on existing entry preserving other fields", async () => {
      await McpAuth.set("server", {
        clientInfo: { clientId: "client-1" },
      })
      await McpAuth.updateTokens("server", { accessToken: "updated-tok" })

      const entry = await McpAuth.get("server")
      expect(entry!.tokens!.accessToken).toBe("updated-tok")
      expect(entry!.clientInfo!.clientId).toBe("client-1")
    })

    test("passes serverUrl through to set", async () => {
      await McpAuth.updateTokens("server", { accessToken: "tok" }, "https://example.com")

      const entry = await McpAuth.get("server")
      expect(entry!.serverUrl).toBe("https://example.com")
    })
  })

  describe("updateClientInfo()", () => {
    test("creates entry if none exists", async () => {
      await McpAuth.updateClientInfo("server", {
        clientId: "client-abc",
        clientSecret: "secret-abc",
      })

      const entry = await McpAuth.get("server")
      expect(entry!.clientInfo!.clientId).toBe("client-abc")
      expect(entry!.clientInfo!.clientSecret).toBe("secret-abc")
    })

    test("updates clientInfo on existing entry preserving other fields", async () => {
      await McpAuth.set("server", { tokens: { accessToken: "tok" } })
      await McpAuth.updateClientInfo("server", { clientId: "new-client" })

      const entry = await McpAuth.get("server")
      expect(entry!.tokens!.accessToken).toBe("tok")
      expect(entry!.clientInfo!.clientId).toBe("new-client")
    })
  })

  describe("codeVerifier", () => {
    test("updateCodeVerifier creates entry if none exists", async () => {
      await McpAuth.updateCodeVerifier("server", "verifier-123")

      const entry = await McpAuth.get("server")
      expect(entry!.codeVerifier).toBe("verifier-123")
    })

    test("clearCodeVerifier removes verifier from entry", async () => {
      await McpAuth.set("server", { tokens: { accessToken: "tok" } })
      await McpAuth.updateCodeVerifier("server", "verifier-123")
      await McpAuth.clearCodeVerifier("server")

      const entry = await McpAuth.get("server")
      expect(entry!.codeVerifier).toBeUndefined()
      expect(entry!.tokens!.accessToken).toBe("tok")
    })

    test("clearCodeVerifier does nothing for nonexistent entry", async () => {
      await McpAuth.clearCodeVerifier("nonexistent")
    })
  })

  describe("oauthState", () => {
    test("updateOAuthState creates entry if none exists", async () => {
      await McpAuth.updateOAuthState("server", "state-abc")

      const state = await McpAuth.getOAuthState("server")
      expect(state).toBe("state-abc")
    })

    test("getOAuthState returns undefined when no state", async () => {
      const state = await McpAuth.getOAuthState("nonexistent")
      expect(state).toBeUndefined()
    })

    test("clearOAuthState removes state from entry", async () => {
      await McpAuth.set("server", { tokens: { accessToken: "tok" } })
      await McpAuth.updateOAuthState("server", "state-abc")
      await McpAuth.clearOAuthState("server")

      const state = await McpAuth.getOAuthState("server")
      expect(state).toBeUndefined()
    })

    test("clearOAuthState does nothing for nonexistent entry", async () => {
      await McpAuth.clearOAuthState("nonexistent")
    })
  })

  describe("isTokenExpired()", () => {
    test("returns null when no tokens exist", async () => {
      const result = await McpAuth.isTokenExpired("nonexistent")
      expect(result).toBeNull()
    })

    test("returns null when entry exists but has no tokens", async () => {
      await McpAuth.set("server", { clientInfo: { clientId: "client-1" } })

      const result = await McpAuth.isTokenExpired("server")
      expect(result).toBeNull()
    })

    test("returns false when tokens have no expiresAt", async () => {
      await McpAuth.set("server", { tokens: { accessToken: "tok" } })

      const result = await McpAuth.isTokenExpired("server")
      expect(result).toBe(false)
    })

    test("returns false when tokens are not expired", async () => {
      const futureExpiry = Date.now() / 1000 + 3600
      await McpAuth.set("server", {
        tokens: { accessToken: "tok", expiresAt: futureExpiry },
      })

      const result = await McpAuth.isTokenExpired("server")
      expect(result).toBe(false)
    })

    test("returns true when tokens are expired", async () => {
      const pastExpiry = Date.now() / 1000 - 3600
      await McpAuth.set("server", {
        tokens: { accessToken: "tok", expiresAt: pastExpiry },
      })

      const result = await McpAuth.isTokenExpired("server")
      expect(result).toBe(true)
    })
  })

  describe("Zod schemas", () => {
    test("Tokens schema validates valid input", () => {
      const result = McpAuth.Tokens.safeParse({
        accessToken: "abc",
        refreshToken: "refresh",
        expiresAt: 12345,
        scope: "read",
      })
      expect(result.success).toBe(true)
    })

    test("Tokens schema requires accessToken", () => {
      const result = McpAuth.Tokens.safeParse({
        refreshToken: "refresh",
      })
      expect(result.success).toBe(false)
    })

    test("ClientInfo schema validates valid input", () => {
      const result = McpAuth.ClientInfo.safeParse({
        clientId: "client-1",
        clientSecret: "secret",
      })
      expect(result.success).toBe(true)
    })

    test("ClientInfo schema requires clientId", () => {
      const result = McpAuth.ClientInfo.safeParse({
        clientSecret: "secret",
      })
      expect(result.success).toBe(false)
    })

    test("Entry schema validates with all optional fields", () => {
      const result = McpAuth.Entry.safeParse({
        tokens: { accessToken: "tok" },
        clientInfo: { clientId: "client-1" },
        codeVerifier: "verifier",
        oauthState: "state",
        serverUrl: "https://example.com",
      })
      expect(result.success).toBe(true)
    })

    test("Entry schema validates with empty object", () => {
      const result = McpAuth.Entry.safeParse({})
      expect(result.success).toBe(true)
    })
  })
})
