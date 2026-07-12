import { afterEach, beforeEach, expect, test } from "bun:test"
import { Auth } from "../../src/provider/api-key"
import { ProviderAuthHealth } from "../../src/provider/auth-health"
import { ProviderAuthRecovery } from "../../src/provider/auth-recovery"
import { ProviderProfile } from "../../src/provider/profile"
import { Bus } from "../../src/bus"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

const PROVIDERS = [
  "test-refresh",
  "test-backup",
  "test-api-confirm",
  "test-wrapped-api",
  "test-status",
  "test-exhausted",
  "test-env",
  "test-missing",
  "test-plugin-with-hooks",
  "test-plugin-without-classifier",
]

async function reset() {
  ProviderProfile.clearPluginProfiles()
  for (const providerID of PROVIDERS) {
    await Auth.remove(providerID).catch(() => {})
    await ProviderAuthHealth.clearObservation(providerID)
  }
}

beforeEach(reset)
afterEach(reset)

test("concurrent credential rejection performs one refresh and each request retries once", async () => {
  await Auth.set("test-refresh", { type: "oauth", access: "old", refresh: "refresh", expires: 9999999999 })
  let refreshes = 0
  let requests = 0

  const execute = () =>
    ProviderAuthRecovery.execute({
      providerID: "test-refresh",
      request: async () => {
        requests++
        const auth = await Auth.get("test-refresh")
        return new Response(null, { status: auth?.type === "oauth" && auth.access === "new" ? 200 : 401 })
      },
      refresh: async (auth) => {
        refreshes++
        await Promise.resolve()
        return auth.type === "oauth" ? { ...auth, access: "new" } : undefined
      },
    })

  const responses = await Promise.all([execute(), execute()])
  expect(responses.map((response) => response.status)).toEqual([200, 200])
  expect(refreshes).toBe(1)
  expect(requests).toBe(4)
})

test("a rejected primary API key switches to a backup within the single retry budget", async () => {
  await Auth.set("test-backup", { type: "api", key: "primary" })
  await Auth.addToPool("test-backup", "backup", { type: "api", key: "backup" })
  const keys: string[] = []

  const response = await ProviderAuthRecovery.execute({
    providerID: "test-backup",
    request: async () => {
      const auth = await Auth.get("test-backup")
      const key = auth?.type === "api" ? auth.key : ""
      keys.push(key)
      return new Response(null, { status: key === "backup" ? 200 : 401 })
    },
  })

  expect(response.status).toBe(200)
  expect(keys).toEqual(["primary", "backup"])
  expect((await Auth.select("test-backup"))?.credentialID).toBe("backup")
  expect(ProviderAuthHealth.fromEntry("test-backup", (await Auth.entries())["test-backup"]).status).toBe("connected")
})

test("a lone API key is invalidated only after a confirmed rejection", async () => {
  await Auth.set("test-api-confirm", { type: "api", key: "transient" })
  let requests = 0

  const recovered = await ProviderAuthRecovery.execute({
    providerID: "test-api-confirm",
    request: async () => new Response(null, { status: ++requests === 1 ? 401 : 200 }),
  })

  expect(recovered.status).toBe(200)
  expect(requests).toBe(2)
  expect(await Auth.get("test-api-confirm")).toMatchObject({ type: "api", key: "transient" })
  expect(ProviderAuthHealth.fromEntry("test-api-confirm", (await Auth.entries())["test-api-confirm"]).status).toBe(
    "connected",
  )

  await Auth.set("test-api-confirm", { type: "api", key: "rejected" })
  requests = 0
  await expect(
    ProviderAuthRecovery.execute({
      providerID: "test-api-confirm",
      request: async () => {
        requests++
        return new Response(null, { status: 401 })
      },
    }),
  ).rejects.toMatchObject({ name: "ProviderAuthenticationRequiredError" })

  expect(requests).toBe(2)
  expect(await Auth.get("test-api-confirm")).toBeUndefined()
  expect(ProviderAuthHealth.fromEntry("test-api-confirm", (await Auth.entries())["test-api-confirm"]).status).toBe(
    "action_required",
  )
})

test("a lone API key confirmation retry preserves request headers and body", async () => {
  await Auth.set("test-api-confirm", { type: "api", key: "valid" })
  const bodies: string[] = []
  const authorizations: string[] = []
  let requests = 0
  const transport = ProviderAuthRecovery.wrapFetch("test-api-confirm", async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    bodies.push(await request.text())
    authorizations.push(new Headers(init?.headers ?? request.headers).get("authorization") ?? "")
    return new Response(null, { status: ++requests === 1 ? 401 : 200 })
  })

  const response = await transport(
    new Request("https://provider.test/v1/messages", {
      method: "POST",
      headers: { Authorization: "Bearer stale" },
      body: JSON.stringify({ prompt: "hello" }),
    }),
  )

  expect(response.status).toBe(200)
  expect(bodies).toEqual(['{"prompt":"hello"}', '{"prompt":"hello"}'])
  expect(authorizations).toEqual(["Bearer valid", "Bearer valid"])
})

test("generic SDK transport rewrites common API-key headers when selecting a backup", async () => {
  await Auth.set("test-wrapped-api", { type: "api", key: "primary" })
  await Auth.addToPool("test-wrapped-api", "backup", { type: "api", key: "backup" })
  const seen: string[] = []
  const transport = ProviderAuthRecovery.wrapFetch("test-wrapped-api", async (_input, init) => {
    const authorization = new Headers(init?.headers).get("authorization") ?? ""
    seen.push(authorization)
    return new Response(null, { status: authorization === "Bearer backup" ? 200 : 401 })
  })

  const response = await transport("https://provider.test/v1/messages", {
    headers: { Authorization: "Bearer primary" },
  })
  expect(response.status).toBe(200)
  expect(seen).toEqual(["Bearer primary", "Bearer backup"])
})

test("403, server failures, and network exceptions do not invalidate credentials without classification", async () => {
  await Auth.set("test-status", { type: "api", key: "valid-until-proven-otherwise" })

  for (const status of [403, 500, 503]) {
    const response = await ProviderAuthRecovery.execute({
      providerID: "test-status",
      request: async () => new Response(null, { status }),
    })
    expect(response.status).toBe(status)
    expect(await Auth.get("test-status")).toMatchObject({ type: "api" })
  }

  await expect(
    ProviderAuthRecovery.execute({
      providerID: "test-status",
      request: async () => {
        throw new TypeError("fetch failed")
      },
    }),
  ).rejects.toThrow("fetch failed")
  expect(await Auth.get("test-status")).toMatchObject({ type: "api" })
})

test("rate limits mark credentials exhausted with retry metadata and never refresh", async () => {
  await Auth.set("test-exhausted", { type: "oauth", access: "access", refresh: "refresh", expires: 9999999999 })
  let refreshes = 0
  const reset = Math.floor(Date.now() / 1000) + 600
  const response = await ProviderAuthRecovery.execute({
    providerID: "test-exhausted",
    request: async () =>
      new Response(null, {
        status: 429,
        headers: { "retry-after": "120", "x-ratelimit-reset": String(reset) },
      }),
    refresh: async () => {
      refreshes++
      return undefined
    },
  })

  expect(response.status).toBe(429)
  expect(refreshes).toBe(0)
  expect(ProviderAuthHealth.fromEntry("test-exhausted", (await Auth.entries())["test-exhausted"])).toMatchObject({
    status: "exhausted",
    resetAt: reset,
  })
})

test("environment credential rejection is process-local and requests an environment update", async () => {
  ProviderProfile.register({
    id: "test-env",
    name: "Test environment provider",
    origin: "plugin",
    env: ["SYNERGY_TEST_ENV_TOKEN"],
    classifyError: ({ status }) =>
      status === 401 ? { code: "test_env_rejected", retryable: false, reloginRequired: true } : undefined,
  })
  process.env.SYNERGY_TEST_ENV_TOKEN = "invalid"
  try {
    await expect(
      ProviderAuthRecovery.execute({
        providerID: "test-env",
        request: async () => new Response(null, { status: 401 }),
      }),
    ).rejects.toMatchObject({ name: "ProviderAuthenticationRequiredError" })

    expect((await Auth.entries())["test-env"]).toBeUndefined()
    expect(ProviderAuthHealth.fromEntry("test-env", undefined)).toMatchObject({
      status: "action_required",
      recovery: "update_environment",
    })

    const recovered = await ProviderAuthRecovery.execute({
      providerID: "test-env",
      request: async () => new Response(null, { status: 200 }),
    })
    expect(recovered.status).toBe(200)
    expect(ProviderAuthHealth.fromEntry("test-env", undefined)).toMatchObject({
      status: "connected",
      source: "env",
    })
    expect((await Auth.entries())["test-env"]).toBeUndefined()
  } finally {
    delete process.env.SYNERGY_TEST_ENV_TOKEN
  }
})

test("a request that cannot start without credentials remains not configured", async () => {
  const missing = Object.assign(new Error("No credentials configured"), {
    data: {
      code: "test_auth_missing",
      reloginRequired: true,
    },
  })

  await expect(
    ProviderAuthRecovery.execute({
      providerID: "test-missing",
      request: async () => {
        throw missing
      },
    }),
  ).rejects.toBe(missing)
  expect(ProviderAuthHealth.fromEntry("test-missing", undefined)).toEqual({
    providerID: "test-missing",
    status: "not_configured",
  })
})

test("plugin classifier and refresh hooks run, while an unclassified plugin 401 remains untouched", async () => {
  let classified = 0
  let refreshed = 0
  ProviderProfile.register({
    id: "test-plugin-with-hooks",
    name: "Test plugin",
    origin: "plugin",
    classifyError: ({ status }) => {
      classified++
      return status === 401 ? { code: "plugin_token_rejected", retryable: false, reloginRequired: true } : undefined
    },
    refreshAuth: async ({ auth }) => {
      refreshed++
      return auth?.type === "oauth" ? { ...auth, access: "plugin-new" } : undefined
    },
  })
  await Auth.set("test-plugin-with-hooks", {
    type: "oauth",
    access: "plugin-old",
    refresh: "plugin-refresh",
    expires: 9999999999,
  })

  const recovered = await ProviderAuthRecovery.execute({
    providerID: "test-plugin-with-hooks",
    request: async () => {
      const auth = await Auth.get("test-plugin-with-hooks")
      return new Response(null, { status: auth?.type === "oauth" && auth.access === "plugin-new" ? 200 : 401 })
    },
  })
  expect(recovered.status).toBe(200)
  expect(classified).toBe(1)
  expect(refreshed).toBe(1)

  ProviderProfile.register({
    id: "test-plugin-without-classifier",
    name: "Unclassified plugin",
    origin: "plugin",
  })
  await Auth.set("test-plugin-without-classifier", { type: "api", key: "plugin-key" })
  const untouched = await ProviderAuthRecovery.execute({
    providerID: "test-plugin-without-classifier",
    request: async () => new Response(null, { status: 401 }),
  })
  expect(untouched.status).toBe(401)
  expect(await Auth.get("test-plugin-without-classifier")).toMatchObject({ type: "api", key: "plugin-key" })
})

test("health events contain only public state and ignore connected token rotation", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const events: unknown[] = []
      const unsubscribe = Bus.subscribe(ProviderAuthHealth.Event.Updated, (event) => events.push(event.properties))
      try {
        await Auth.set("test-refresh", { type: "api", key: "secret-primary" }, { source: "api" })
        events.length = 0

        await Auth.replaceSelectedCredential("test-refresh", { type: "api", key: "secret-rotated" }, { source: "api" })
        expect(events).toEqual([])

        await Auth.markDead("test-refresh", "credential_rejected")
        expect(events).toHaveLength(1)
        expect(events[0]).toEqual({
          health: {
            providerID: "test-refresh",
            status: "action_required",
            recovery: "reconnect",
            authKind: "api_key",
            source: "api",
            updatedAt: expect.any(Number),
            failureCode: "credential_rejected",
          },
        })
        expect(JSON.stringify(events)).not.toContain("secret-primary")
        expect(JSON.stringify(events)).not.toContain("secret-rotated")
      } finally {
        unsubscribe()
      }
    },
  })
})
