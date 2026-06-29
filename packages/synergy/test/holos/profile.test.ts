import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../../src/global"
import { HolosAccounts } from "../../src/holos/accounts"
import { migrations } from "../../src/holos/migration"
import { HolosProfile } from "../../src/holos/profile"
import { HolosState } from "../../src/holos/state"
import { HolosDataRoute, HolosRoute } from "../../src/server/holos"

const originalFetch = globalThis.fetch
const originalWebSocket = globalThis.WebSocket

function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  })
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    return handler(url, init)
  }) as typeof fetch
}

class TestWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  readyState = TestWebSocket.OPEN
  private listeners = new Map<string, Array<(event: unknown) => void>>()

  constructor() {
    setTimeout(() => this.emit("open", {}), 0)
  }

  addEventListener(event: string, listener: (event: unknown) => void) {
    const listeners = this.listeners.get(event) ?? []
    listeners.push(listener)
    this.listeners.set(event, listeners)
  }

  send() {}

  close() {
    this.readyState = TestWebSocket.CLOSED
    this.emit("close", {})
  }

  private emit(event: string, payload: unknown) {
    for (const listener of this.listeners.get(event) ?? []) listener(payload)
  }
}

afterEach(async () => {
  const { HolosRuntime } = await import("../../src/holos/runtime")
  await HolosRuntime.stop().catch(() => {})
  globalThis.fetch = originalFetch
  globalThis.WebSocket = originalWebSocket
  await fs.rm(Global.Path.authHolosAccounts, { force: true }).catch(() => {})
  await fs.rm(Global.Path.authApiKey, { force: true }).catch(() => {})
})

describe("HolosProfile", () => {
  test("normalizes remote profile fields from /agent_tunnel/me", async () => {
    mockFetch(() =>
      json({
        code: 0,
        data: {
          agent_id: "agent_remote",
          profile: {
            name: "Remote Agent",
            description: "Remote description",
            avatar_url: "https://example.com/avatar.png",
          },
        },
      }),
    )

    const me = await HolosProfile.getMe({ agentSecret: "secret" })

    expect(me.agentId).toBe("agent_remote")
    expect(me.profile).toEqual({
      name: "Remote Agent",
      description: "Remote description",
      avatarUrl: "https://example.com/avatar.png",
    })
  })

  test("profile save merges unknown remote fields before POSTing to Holos", async () => {
    const bodies: unknown[] = []
    mockFetch((url, init) => {
      if (url.endsWith("/api/v1/holos/agent_tunnel/me")) {
        return json({
          code: 0,
          data: {
            agent_id: "agent_profile",
            profile: {
              name: "Old",
              description: "Old description",
              avatar_url: "https://example.com/old.png",
              color: "green",
            },
          },
        })
      }
      if (url.endsWith("/api/v1/holos/agent_tunnel/me/profile")) {
        bodies.push(JSON.parse(String(init?.body)))
        return json({
          code: 0,
          data: {
            agent_id: "agent_profile",
            profile: (bodies[0] as { profile: Record<string, unknown> }).profile,
          },
        })
      }
      throw new Error(`Unexpected fetch ${url}`)
    })

    const updated = await HolosProfile.updateCurrent({
      agentId: "agent_profile",
      agentSecret: "secret",
      profile: { name: "New", description: "New description", avatarUrl: "" },
    })

    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toEqual({
      profile: {
        name: "New",
        description: "New description",
        avatar_url: "",
        color: "green",
      },
    })
    expect(updated.profile).toEqual({
      name: "New",
      description: "New description",
      avatarUrl: null,
    })
  })
})

describe("Holos profile routes", () => {
  test("import validates with /me, saves canonical agent id, and does not overwrite remote profile", async () => {
    const calls: Array<{ url: string; method: string }> = []
    globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket
    mockFetch((url, init) => {
      calls.push({ url, method: init?.method ?? "GET" })
      if (url.endsWith("/api/v1/holos/agent_tunnel/me")) {
        return json({
          code: 0,
          data: {
            agent_id: "agent_imported",
            profile: { name: "Imported", description: "Existing", avatar_url: "" },
          },
        })
      }
      if (url.endsWith("/api/v1/holos/agent_tunnel/ws_token")) {
        return json({ code: 0, data: { ws_token: "token", expires_in: 60 } })
      }
      throw new Error(`Unexpected fetch ${url}`)
    })

    const app = new Hono().route("/holos", HolosRoute)
    const res = await app.request("/holos/credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentSecret: "secret_import" }),
    })
    const body = await res.json()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(res.status).toBe(200)
    expect(body).toEqual({
      success: true,
      agentId: "agent_imported",
      profile: { name: "Imported", description: "Existing", avatarUrl: null },
    })
    expect(calls.some((call) => call.url.endsWith("/api/v1/holos/agent_tunnel/me/profile"))).toBe(false)
    expect((await HolosAccounts.getActiveAccount())?.agentId).toBe("agent_imported")
  })

  test("profile update route preserves unknown fields and returns normalized profile", async () => {
    await HolosAccounts.saveAndActivateAccount("agent_profile", "secret_profile")
    const bodies: unknown[] = []
    mockFetch((url, init) => {
      if (url.endsWith("/api/v1/holos/agent_tunnel/me")) {
        return json({
          code: 0,
          data: {
            agent_id: "agent_profile",
            profile: { name: "Old", description: "Old", avatar_url: "", skill: "research" },
          },
        })
      }
      if (url.endsWith("/api/v1/holos/agent_tunnel/me/profile")) {
        bodies.push(JSON.parse(String(init?.body)))
        return json({
          code: 0,
          data: {
            agent_id: "agent_profile",
            profile: (bodies[0] as { profile: Record<string, unknown> }).profile,
          },
        })
      }
      throw new Error(`Unexpected fetch ${url}`)
    })

    const app = new Hono().route("/holos", HolosDataRoute)
    const res = await app.request("/holos/profile", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Edited", description: "Edited profile", avatarUrl: "https://example.com/a.png" }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(bodies[0]).toEqual({
      profile: {
        name: "Edited",
        description: "Edited profile",
        avatar_url: "https://example.com/a.png",
        skill: "research",
      },
    })
    expect(body).toEqual({
      agentId: "agent_profile",
      profile: { name: "Edited", description: "Edited profile", avatarUrl: "https://example.com/a.png" },
    })
  })
})

describe("Holos state and migration", () => {
  test("state returns null profile and profileError when remote profile fetch fails", async () => {
    await HolosAccounts.saveAndActivateAccount("agent_state", "secret_state")
    mockFetch(() => json({ message: "unavailable" }, { status: 503 }))

    const state = await HolosState.get()

    expect(state.social.profile).toBeNull()
    expect(state.social.profileError).toContain("Holos profile fetch failed")
    expect(JSON.stringify(state.social)).not.toContain("initialized")
    expect(JSON.stringify(state.social)).not.toContain("bio")
  })

  test("migration removes old local account labels while preserving credentials", async () => {
    await fs.mkdir(path.dirname(Global.Path.authHolosAccounts), { recursive: true })
    await Bun.write(
      Global.Path.authHolosAccounts,
      JSON.stringify(
        {
          activeAccountId: "agent_labeled",
          accounts: {
            agent_labeled: {
              agentId: "agent_labeled",
              agentSecret: "secret_labeled",
              label: "Local label",
              createdAt: 1,
              updatedAt: 2,
            },
          },
        },
        null,
        2,
      ),
    )

    const migration = migrations.find((entry) => entry.id === "20260629-holos-account-profile-source-of-truth")
    expect(migration).toBeDefined()
    await migration!.up(() => {})

    const raw = await Bun.file(Global.Path.authHolosAccounts).json()
    expect(raw.accounts.agent_labeled).toEqual({
      agentId: "agent_labeled",
      agentSecret: "secret_labeled",
      createdAt: 1,
      updatedAt: 2,
    })
  })
})
