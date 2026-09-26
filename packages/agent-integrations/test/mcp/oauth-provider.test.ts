import { afterAll, expect, test } from "bun:test"
import { McpAuth } from "../../src/mcp/auth"
import { McpOAuthProvider } from "../../src/mcp/oauth-provider"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test.each(["all", "client", "tokens", "verifier"] as const)(
  "stale OAuth owners cannot invalidate %s credentials",
  (scope) =>
    runtime.run(async () => {
      const name = `stale-${scope}`
      const url = "https://mcp.example.com"
      const entry = {
        tokens: { accessToken: "new-access" },
        clientInfo: { clientId: "new-client" },
        codeVerifier: "new-verifier",
        oauthState: "new-state",
        serverUrl: url,
      }
      await McpAuth.set(name, entry, url)
      const provider = new McpOAuthProvider(name, url, {}, { onRedirect() {}, isCurrent: () => false })

      await provider.invalidateCredentials(scope)

      expect(await McpAuth.get(name)).toEqual(entry)
    }),
)

test.each([false, true])("background verifier invalidation stays local (stored=%s)", (stored) =>
  runtime.run(async () => {
    const name = `background-verifier-${stored}`
    const url = "https://mcp.example.com"
    const entry = {
      clientInfo: { clientId: "interactive-client" },
      codeVerifier: "interactive-verifier",
      oauthState: "interactive-state",
      serverUrl: url,
    }
    if (stored) await McpAuth.set(name, entry, url)
    const provider = new McpOAuthProvider(name, url, {}, { onRedirect() {} }, "background")
    await provider.saveCodeVerifier("probe-verifier")

    await provider.invalidateCredentials("verifier")

    expect(await McpAuth.get(name)).toEqual(stored ? entry : undefined)
    await expect(provider.codeVerifier()).rejects.toThrow("No code verifier")
  }),
)

test("current interactive owners can invalidate their verifier and registration", () =>
  runtime.run(async () => {
    const name = "current-owner"
    const url = "https://mcp.example.com"
    await McpAuth.set(name, { codeVerifier: "verifier", clientInfo: { clientId: "client" } }, url)
    const provider = new McpOAuthProvider(name, url, {}, { onRedirect() {}, isCurrent: () => true })

    await provider.invalidateCredentials("verifier")
    expect((await McpAuth.get(name))?.codeVerifier).toBeUndefined()
    expect((await McpAuth.get(name))?.clientInfo?.clientId).toBe("client")
    await provider.invalidateCredentials("all")
    expect(await McpAuth.get(name)).toBeUndefined()
  }))
