import { expect, test } from "bun:test"
import { createOrganizationConnections } from "../../src/organization/connections"
import type { OrgClientTokens } from "@ericsanchezok/synergy-sdk/organization"

test("native authorization failures suspend only their captured current space", async () => {
  const values = new Map<string, string>()
  const storage = {
    get length() {
      return values.size
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
    clear: () => values.clear(),
  }
  let accountID = "a"
  const registry = createOrganizationConnections({
    storage,
    origins: ["https://org.example"],
    redirectUri: "https://app.example/organization.html",
    authorize: async (): Promise<OrgClientTokens> => ({
      issuer: "https://org.example",
      orgID: "org",
      deploymentIncarnation: "deployment",
      clientID: "web",
      account: {
        accountID,
        orgID: "org",
        loginName: accountID,
        displayName: accountID,
        role: "member",
        state: "active",
        revision: 1,
        authRevision: 1,
        createdAt: 0,
      },
      tokenType: "Bearer",
      accessToken: "a".repeat(64),
      expiresAt: Date.now() + 60_000,
    }),
  })
  try {
    await registry.connect({ issuer: "https://org.example", clientID: "web" })
    const first = registry.current()!
    accountID = "b"
    await registry.connect({ issuer: "https://org.example", clientID: "web" })
    const second = registry.current()!
    registry.authorizationRequired(first)
    expect(registry.current()).toBe(second)
    expect(registry.connection()?.state).toBe("ready")
    registry.select(registry.selected())
    const current = registry.current()!
    registry.authorizationRequired(second)
    expect(registry.current()).toBe(current)
    expect(registry.connection()?.state).toBe("ready")
    registry.authorizationRequired(current)
    expect(current.signal.aborted).toBe(true)
    expect(registry.current()).toBeUndefined()
    expect(registry.client()).toBeUndefined()
    expect(registry.connection()?.state).toBe("reauthorization_required")
  } finally {
    registry.dispose()
  }
})
