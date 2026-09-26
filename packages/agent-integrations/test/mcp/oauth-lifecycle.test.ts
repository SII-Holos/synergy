import { afterAll, expect, test } from "bun:test"
import { auth } from "@modelcontextprotocol/sdk/client/auth.js"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { createOAuthMcpServerFixture } from "@ericsanchezok/synergy-testing/oauth-mcp-server"
import { McpAuth } from "../../src/mcp/auth"
import { McpOAuthProvider } from "../../src/mcp/oauth-provider"
import { MCP } from "../../src/mcp"
import { McpSupervisor } from "../../src/mcp/supervisor"
import { PendingOAuth } from "../../src/mcp/pending-oauth"
import { McpOAuthCallback } from "../../src/mcp/oauth-callback"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test.each(["success", "invalid_grant", "invalid_client"])(
  "a late %s from an old SDK refresh preserves the completed login during cleanup",
  (outcome) =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ config: {} })
      await using fixture = createOAuthMcpServerFixture()
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          await McpSupervisor().ready()
          const name = `late-${outcome}`
          McpSupervisor().add(name, {
            type: "remote",
            url: fixture.url,
            startup: "manual",
            oauth: { scope: fixture.scope },
          })
          await McpAuth.set(name, { tokens: { accessToken: "old-access", refreshToken: "old-refresh" } }, fixture.url)
          const entered = Promise.withResolvers<void>()
          const released = Promise.withResolvers<void>()
          const cleanupEntered = Promise.withResolvers<void>()
          const cleanupReleased = Promise.withResolvers<void>()
          const origin = new URL(fixture.url).origin
          const old = new McpOAuthProvider(
            name,
            fixture.url,
            { clientId: "fixture-client" },
            { onRedirect() {} },
            "background",
          )
          const refresh = auth(old, {
            serverUrl: fixture.url,
            fetchFn: async (input, init) => {
              if (new URL(input).pathname === "/token") {
                entered.resolve()
                await released.promise
                return outcome === "success"
                  ? Response.json({ access_token: "late-access", refresh_token: "late-refresh", token_type: "Bearer" })
                  : Response.json({ error: outcome }, { status: 400 })
              }
              if (new URL(input).pathname.includes("oauth-authorization-server"))
                return Response.json({
                  issuer: origin,
                  authorization_endpoint: `${origin}/authorize`,
                  token_endpoint: `${origin}/token`,
                  response_types_supported: ["code"],
                  code_challenge_methods_supported: ["S256"],
                })
              return fetch(input, init)
            },
          }).catch((error) => error)
          try {
            await entered.promise
            const { authorizationUrl } = await MCP.startAuth(name)
            const { code } = await fixture.followAuthorization(authorizationUrl)
            const pending = PendingOAuth.get(name)!
            const close = pending.client.close.bind(pending.client)
            pending.client.close = async () => {
              await close()
              cleanupEntered.resolve()
              await cleanupReleased.promise
            }
            const finished = MCP.finishAuth(name, code)
            const duplicate = MCP.finishAuth(name, code)
            await cleanupEntered.promise
            const lateDuplicate = MCP.finishAuth(name, code).catch((error) => error)
            const credentials = await McpAuth.get(name)
            expect(credentials?.tokens?.accessToken).toBeDefined()
            expect(McpAuth.isAuthenticating(name)).toBe(true)
            const before = fixture.snapshot().mcpRequests.length
            await McpSupervisor().checkNeedsAuthNow()
            expect(fixture.snapshot().mcpRequests).toHaveLength(before)
            released.resolve()
            await refresh
            expect(await McpAuth.get(name)).toMatchObject({
              tokens: credentials!.tokens,
              clientInfo: credentials!.clientInfo,
            })
            cleanupReleased.resolve()
            expect(await finished).toEqual({ status: "connected" })
            expect(await duplicate).toEqual({ status: "connected" })
            expect(await lateDuplicate).toEqual({ status: "connected" })
            expect(fixture.snapshot().tokenExchanges).toHaveLength(1)
            expect(McpAuth.isAuthenticating(name)).toBe(false)
          } finally {
            released.resolve()
            cleanupReleased.resolve()
            await refresh
            await MCP.stop()
          }
        },
      })
    }),
)

test.each(["logout", "disconnect", "replace"] as const)("%s revokes a pending exchange before a late save", (action) =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ config: {} })
    await using fixture = createOAuthMcpServerFixture()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await McpSupervisor().ready()
        const name = `exchange-${action}`
        const config = {
          type: "remote" as const,
          url: fixture.url,
          startup: "manual" as const,
          oauth: { scope: fixture.scope },
        }
        const handle = McpSupervisor().add(name, config)
        const owner = await McpSupervisor().prepareAuth(name, handle.identity)
        const provider = new McpOAuthProvider(name, fixture.url, {}, { onRedirect() {} })
        const entered = Promise.withResolvers<void>()
        const released = Promise.withResolvers<void>()
        await PendingOAuth.register(name, {
          identity: handle.identity,
          owner,
          client: { async close() {} },
          transport: {
            async finishAuth() {
              entered.resolve()
              await released.promise
              await provider.saveTokens({ access_token: "late-exchange", token_type: "Bearer" })
            },
          },
        })
        const finished = MCP.finishAuth(name, "code")
        try {
          await entered.promise
          if (action === "logout") await MCP.removeAuth(name)
          if (action === "disconnect") await McpSupervisor().disconnect(name)
          if (action === "replace") McpSupervisor().add(name, { ...config, headers: { "x-version": "replacement" } })
          released.resolve()
          expect((await finished).status).toBe("failed")
          expect((await McpAuth.get(name))?.tokens).toBeUndefined()
          expect(McpAuth.isAuthenticating(name)).toBe(false)
        } finally {
          released.resolve()
          await finished
          await MCP.stop()
        }
      },
    })
  }),
)

test("restarting authorization cancels only the superseded callback", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ config: {} })
    await using fixture = createOAuthMcpServerFixture()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await McpSupervisor().ready()
        const name = "restarted-callback"
        McpSupervisor().add(name, {
          type: "remote",
          url: fixture.url,
          startup: "manual",
          oauth: { scope: fixture.scope },
        })
        try {
          await MCP.startAuth(name)
          const oldState = (await McpAuth.getOAuthState(name))!
          let cancelled: Error | undefined
          const old = McpOAuthCallback.waitForCallback(oldState, name).catch((error) => {
            cancelled = error
          })
          const { authorizationUrl } = await MCP.startAuth(name)
          expect(cancelled?.message).toBe("Authorization cancelled")
          expect(await McpAuth.getOAuthState(name)).not.toBe(oldState)
          const { code } = await fixture.followAuthorization(authorizationUrl)
          expect((await MCP.finishAuth(name, code)).status).toBe("connected")
          await old
        } finally {
          await MCP.stop()
        }
      },
    })
  }))

test("disconnect during finish cleanup prevents the completed login from reconnecting", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ config: {} })
    await using fixture = createOAuthMcpServerFixture()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await McpSupervisor().ready()
        const name = "disconnect-finish-cleanup"
        McpSupervisor().add(name, {
          type: "remote",
          url: fixture.url,
          startup: "manual",
          oauth: { scope: fixture.scope },
        })
        const { authorizationUrl } = await MCP.startAuth(name)
        const { code } = await fixture.followAuthorization(authorizationUrl)
        const pending = PendingOAuth.get(name)!
        const cleanupEntered = Promise.withResolvers<void>()
        const cleanupReleased = Promise.withResolvers<void>()
        const close = pending.client.close.bind(pending.client)
        pending.client.close = async () => {
          await close()
          cleanupEntered.resolve()
          await cleanupReleased.promise
        }
        const finished = MCP.finishAuth(name, code)
        try {
          await cleanupEntered.promise
          await McpSupervisor().disconnect(name)
          cleanupReleased.resolve()
          expect((await finished).status).toBe("failed")
          expect((await MCP.status())[name]?.status).toBe("disabled")
        } finally {
          cleanupReleased.resolve()
          await finished
          await MCP.stop()
        }
      },
    })
  }))

test("logout cleanup cannot erase a later login's PKCE state or credentials", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ config: {} })
    await using fixture = createOAuthMcpServerFixture()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await McpSupervisor().ready()
        const name = "logout-cleanup"
        const handle = McpSupervisor().add(name, { type: "remote", url: fixture.url, startup: "manual" })
        const previous = await McpSupervisor().prepareAuth(name, handle.identity)
        const closing = Promise.withResolvers<void>()
        const released = Promise.withResolvers<void>()
        await PendingOAuth.register(name, {
          identity: handle.identity,
          owner: previous,
          client: {
            async close() {
              closing.resolve()
              await released.promise
            },
          },
          transport: { async finishAuth() {} },
        })
        const logout = MCP.removeAuth(name)
        try {
          await closing.promise
          const next = await McpSupervisor().prepareAuth(name, handle.identity)
          const provider = new McpOAuthProvider(name, fixture.url, {}, { onRedirect() {} })
          await provider.saveState("new-state")
          await provider.saveCodeVerifier("new-verifier")
          await provider.saveTokens({ access_token: "new-login", token_type: "Bearer" })
          released.resolve()
          await logout
          expect(next.isCurrent()).toBe(true)
          expect(await McpAuth.get(name)).toMatchObject({
            oauthState: "new-state",
            codeVerifier: "new-verifier",
            tokens: { accessToken: "new-login" },
          })
        } finally {
          released.resolve()
          await logout
          await MCP.stop()
        }
      },
    })
  }))
