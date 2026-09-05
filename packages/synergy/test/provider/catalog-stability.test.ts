import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "fs/promises"
import { Global } from "../../src/global"
import { ProviderCatalog } from "../../src/provider/catalog"
import { ProviderProfile } from "../../src/provider/profile"
import { Auth } from "../../src/provider/api-key"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"
import { Env } from "../../src/util/env"

const config = {}
const providerID = `catalog-stability-${Math.random().toString(36).slice(2)}`
let identity = "account-a"
let fetchCatalog: () => Promise<ProviderProfile.ModelCatalogEntry[]>
const credentialProviderID = `catalog-credentials-${Math.random().toString(36).slice(2)}`
const alternateProfileID = `catalog-alternate-profile-${Math.random().toString(36).slice(2)}`
const configuredProfileID = `catalog-configured-profile-${Math.random().toString(36).slice(2)}`
const configuredProviderID = `catalog-configured-provider-${Math.random().toString(36).slice(2)}`
const environmentProfileID = `catalog-environment-profile-${Math.random().toString(36).slice(2)}`
const environmentProviderID = `catalog-environment-provider-${Math.random().toString(36).slice(2)}`
const inlineProviderID = `catalog-inline-credentials-${Math.random().toString(36).slice(2)}`
const environmentName = "SYNERGY_TEST_CATALOG_ACCOUNT_KEY"
const mappedEnvironmentName = "SYNERGY_TEST_MAPPED_CATALOG_ACCOUNT_KEY"
let alternateFetchCalls = 0
let environmentDiscoveryAuth: string | undefined
const environmentDiscoveryByProvider = new Map<string, string | undefined>()

ProviderProfile.register({
  id: providerID,
  name: "Catalog Stability Test",
  authKind: "none",
  modelsDevProviderID: "openai",
  fallbackModels: ["gpt-5.5"],
  modelCatalogIdentity: () => identity,
  fetchModelCatalog: () => fetchCatalog(),
})

ProviderProfile.register({
  id: alternateProfileID,
  name: "Catalog Alternate Profile Test",
  authKind: "none",
  modelsDevProviderID: "openai",
  fallbackModels: ["gpt-5.5"],
  modelCatalogIdentity: () => identity,
  fetchModelCatalog: async () => {
    alternateFetchCalls++
    return [{ id: "alternate-model" }]
  },
})

ProviderProfile.register({
  id: environmentProfileID,
  name: "Catalog Environment Profile Test",
  authKind: "api_key",
  modelsDevProviderID: "openai",
  baseURL: "https://environment-catalog.invalid/v1",
  env: [environmentName],
  fallbackModels: ["gpt-5.5"],
  fetchModelCatalog: async ({ providerID, auth }) => {
    environmentDiscoveryAuth = auth?.type === "api" ? auth.key : undefined
    environmentDiscoveryByProvider.set(providerID, environmentDiscoveryAuth)
    return [{ id: "environment-model" }]
  },
})

let configuredBaseURL: string | undefined
let configuredDiscovery: Promise<void> | undefined
let resolveConfiguredDiscovery: (() => void) | undefined
ProviderProfile.register({
  id: configuredProfileID,
  name: "Catalog Configured Endpoint Test",
  authKind: "none",
  modelsDevProviderID: "openai",
  fallbackModels: ["gpt-5.5"],
  fetchModelCatalog: async ({ providerID, baseURL }) => {
    if (providerID === configuredProviderID) {
      configuredBaseURL = baseURL
      resolveConfiguredDiscovery?.()
    }
    return [{ id: "configured-model" }, { id: "blocked-live-model" }]
  },
})

ProviderProfile.register({
  id: credentialProviderID,
  name: "Catalog Credential Isolation Test",
  authKind: "api_key",
  modelsDevProviderID: "openai",
  fallbackModels: ["gpt-5.5"],
  fetchModelCatalog: async ({ auth }) => [
    { id: auth?.type === "api" && auth.key === "account-b-key" ? "model-b" : "model-a" },
  ],
})

async function reset() {
  identity = "account-a"
  fetchCatalog = async () => []
  alternateFetchCalls = 0
  environmentDiscoveryAuth = undefined
  environmentDiscoveryByProvider.clear()
  // Env.set mutates the process environment directly; clear it between tests
  // so a leftover canonical key cannot drive the environment-profile refresh
  // and clobber the shared discovery callback during a later test.
  delete process.env[environmentName]
  delete process.env[mappedEnvironmentName]
  configuredBaseURL = undefined
  configuredDiscovery = new Promise<void>((resolve) => {
    resolveConfiguredDiscovery = resolve
  })
  await Auth.remove(credentialProviderID).catch(() => {})
  await Auth.remove(inlineProviderID).catch(() => {})
  ProviderCatalog.reset()
  await fs.rm(Global.Path.providerModelCatalogCache, { force: true })
}

async function waitForEnvironmentDiscovery(providerID: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (environmentDiscoveryByProvider.has(providerID)) return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for catalog discovery for ${providerID}`)
}

beforeEach(reset)
afterEach(reset)

test("startup serves bundled models before background discovery completes", async () => {
  let release!: (entries: ProviderProfile.ModelCatalogEntry[]) => void
  let started!: () => void
  const didStart = new Promise<void>((resolve) => {
    started = resolve
  })
  fetchCatalog = () => {
    started()
    return new Promise((resolve) => (release = resolve))
  }

  const catalog = await ProviderCatalog.resolve({ config, includeLive: true })
  expect(catalog[providerID].models["gpt-5.5"]).toBeDefined()

  await didStart
  release([{ id: "model-background" }])
  await ProviderCatalog.refresh(providerID)
})

test("successful refresh persists active models and retains models missing from the next catalog", async () => {
  fetchCatalog = async () => [{ id: "model-a" }, { id: "model-b" }]
  await ProviderCatalog.refresh(providerID)

  fetchCatalog = async () => [{ id: "model-b" }, { id: "model-c" }]
  await ProviderCatalog.refresh(providerID)
  ProviderCatalog.reset()

  const catalog = await ProviderCatalog.resolve({ config, includeLive: true })
  expect(catalog[providerID].models["model-b"].catalog_state).toBe("active")
  expect(catalog[providerID].models["model-c"].catalog_state).toBe("active")
  expect(catalog[providerID].models["model-a"].catalog_state).toBe("retained")
})

test("a retained model becomes active again when the provider returns it", async () => {
  fetchCatalog = async () => [{ id: "model-returning" }, { id: "model-steady" }]
  await ProviderCatalog.refresh(providerID)
  fetchCatalog = async () => [{ id: "model-steady" }]
  await ProviderCatalog.refresh(providerID)
  fetchCatalog = async () => [{ id: "model-returning" }, { id: "model-steady" }]
  await ProviderCatalog.refresh(providerID)

  ProviderCatalog.reset()
  const catalog = await ProviderCatalog.resolve({ config, includeLive: true })
  expect(catalog[providerID].models["model-returning"].catalog_state).toBe("active")
})

test("timeout and empty responses preserve the last successful model set", async () => {
  fetchCatalog = async () => [{ id: "model-stable" }]
  await ProviderCatalog.refresh(providerID)

  fetchCatalog = async () => {
    throw new DOMException("timed out", "TimeoutError")
  }
  const timedOut = await ProviderCatalog.refresh(providerID)
  expect(timedOut.failure).toBe("timeout")

  fetchCatalog = async () => []
  const empty = await ProviderCatalog.refresh(providerID)
  expect(empty.failure).toBe("invalid_response")

  ProviderCatalog.reset()
  const catalog = await ProviderCatalog.resolve({ config, includeLive: true })
  expect(catalog[providerID].models["model-stable"].catalog_state).toBe("active")
})

test("a failed refresh without a prior verified catalog keeps bundled fallback models", async () => {
  fetchCatalog = async () => {
    throw new DOMException("timed out", "TimeoutError")
  }
  await ProviderCatalog.refresh(providerID)
  expect(ProviderCatalog.modelCatalogState(providerID)?.failure).toBe("timeout")

  ProviderCatalog.reset()
  const catalog = await ProviderCatalog.resolve({ config, includeLive: true })
  expect(catalog[providerID].models["gpt-5.5"]).toBeDefined()
})

test("refresh is single-flight per provider", async () => {
  let release!: (entries: ProviderProfile.ModelCatalogEntry[]) => void
  let started!: () => void
  const didStart = new Promise<void>((resolve) => {
    started = resolve
  })
  let calls = 0
  fetchCatalog = () => {
    calls++
    started()
    return new Promise((resolve) => {
      release = resolve
    })
  }

  const first = ProviderCatalog.refresh(providerID)
  await didStart
  const second = ProviderCatalog.refresh(providerID)
  expect(calls).toBe(1)
  release([{ id: "model-once" }])

  expect(await second).toEqual(await first)
  expect(calls).toBe(1)
})

test("catalog snapshots are isolated by opaque identity hashes", async () => {
  fetchCatalog = async () => [{ id: identity === "account-a" ? "model-a" : "model-b" }]
  await ProviderCatalog.refresh(providerID)
  identity = "account-b"
  await ProviderCatalog.refresh(providerID)

  const persisted = await Bun.file(Global.Path.providerModelCatalogCache).text()
  expect(persisted).not.toContain("account-a")
  expect(persisted).not.toContain("account-b")

  ProviderCatalog.reset()
  const accountB = await ProviderCatalog.resolve({ config, includeLive: true })
  expect(accountB[providerID].models["model-b"].catalog_state).toBe("active")
  expect(accountB[providerID].models["model-a"]).toBeUndefined()

  identity = "account-a"
  ProviderCatalog.reset()
  const accountA = await ProviderCatalog.resolve({ config, includeLive: true })
  expect(accountA[providerID].models["model-a"].catalog_state).toBe("active")
  expect(accountA[providerID].models["model-b"]).toBeUndefined()
})

test("catalog snapshots include the runtime profile identity", async () => {
  fetchCatalog = async () => [{ id: "primary-model" }]
  await ProviderCatalog.refresh(providerID)
  await ProviderCatalog.refresh(providerID, alternateProfileID)

  const persisted = JSON.parse(await Bun.file(Global.Path.providerModelCatalogCache).text())
  const matching = persisted.snapshots.filter((snapshot: { providerID: string }) => snapshot.providerID === providerID)
  expect(matching).toHaveLength(2)
  expect(new Set(matching.map((snapshot: { identityHash: string }) => snapshot.identityHash)).size).toBe(2)
})

test("catalog snapshots include the normalized discovery endpoint", async () => {
  fetchCatalog = async () => [{ id: "endpoint-model" }]
  await ProviderCatalog.refresh(providerID, undefined, "https://first.invalid/v1/")
  await ProviderCatalog.refresh(providerID, undefined, "https://second.invalid/v1")

  const persisted = JSON.parse(await Bun.file(Global.Path.providerModelCatalogCache).text())
  const matching = persisted.snapshots.filter((snapshot: { providerID: string }) => snapshot.providerID === providerID)
  expect(matching).toHaveLength(2)
  expect(new Set(matching.map((snapshot: { identityHash: string }) => snapshot.identityHash)).size).toBe(2)
  expect(JSON.stringify(matching)).not.toContain("first.invalid")
  expect(JSON.stringify(matching)).not.toContain("second.invalid")
})

test("configured account endpoint is passed to live model discovery", async () => {
  await ProviderCatalog.resolve({
    config: {
      provider: {
        [configuredProviderID]: {
          profile: configuredProfileID,
          options: { baseURL: "https://account.invalid/v1" },
        },
      },
    },
    includeLive: true,
    forceRefresh: true,
  })
  await configuredDiscovery

  expect(configuredBaseURL).toBe("https://account.invalid/v1")
})

test("explicit refresh honors a configured profile for a registered provider ID", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/synergy.json`,
        JSON.stringify({
          provider: {
            [providerID]: {
              profile: alternateProfileID,
              modelsDevProviderID: "openai",
            },
          },
        }),
      )
    },
  })
  fetchCatalog = async () => [{ id: "wrong-primary-model" }]

  const result = await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: () => ProviderCatalog.refresh(providerID),
  })

  expect(alternateFetchCalls).toBe(1)
  expect(result.modelCount).toBe(1)
})

test("configured environment credentials participate in live discovery", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/synergy.json`,
        JSON.stringify({
          provider: {
            [environmentProviderID]: {
              profile: environmentProfileID,
              modelsDevProviderID: "openai",
              env: [mappedEnvironmentName],
            },
          },
        }),
      )
    },
  })

  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      Env.set(environmentName, "canonical-environment-key")
      Env.set(mappedEnvironmentName, "environment-account-key")
      await ProviderCatalog.resolve({
        config: {
          provider: {
            [environmentProviderID]: {
              profile: environmentProfileID,
              modelsDevProviderID: "openai",
              env: [mappedEnvironmentName],
            },
          },
        },
        includeLive: true,
        forceRefresh: true,
      })
      await waitForEnvironmentDiscovery(environmentProviderID)
    },
  })

  expect(environmentDiscoveryByProvider.get(environmentProviderID)).toBe("environment-account-key")
})

test("connection model rules remain applied after live discovery", async () => {
  const configured = {
    profile: configuredProfileID,
    modelsDevProviderID: "openai",
    api: "https://configured-catalog.invalid/v1",
    whitelist: ["configured-model"],
    models: {
      "configured-model": {
        name: "Account-specific configured model",
      },
    },
  }
  await using tmp = await tmpdir()

  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      await ProviderCatalog.refresh(
        configuredProviderID,
        configuredProfileID,
        "https://configured-catalog.invalid/v1",
        configured,
      )
      const catalog = await ProviderCatalog.resolve({
        config: {
          provider: { [configuredProviderID]: configured },
        },
        includeLive: true,
        forceRefresh: true,
      })

      expect(Object.keys(catalog[configuredProviderID].models)).toEqual(["configured-model"])
      expect(catalog[configuredProviderID].models["configured-model"].name).toBe("Account-specific configured model")
      expect(ProviderCatalog.modelCatalogState(configuredProviderID)?.modelCount).toBe(1)
    },
  })
})

test("canonical profile environment credentials participate in live discovery", async () => {
  await using tmp = await tmpdir()

  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      Env.set(environmentName, "canonical-environment-key")
      await ProviderCatalog.resolve({
        config,
        includeLive: true,
        forceRefresh: true,
      })
      await waitForEnvironmentDiscovery(environmentProfileID)
    },
  })

  expect(environmentDiscoveryByProvider.get(environmentProfileID)).toBe("canonical-environment-key")
})

test("mapped connections do not inherit canonical profile environment credentials", async () => {
  const mappedProviderID = `catalog-unbound-environment-${Math.random().toString(36).slice(2)}`
  await using tmp = await tmpdir()

  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      Env.set(environmentName, "canonical-environment-key")
      await ProviderCatalog.resolve({
        config: {
          provider: {
            [mappedProviderID]: {
              profile: environmentProfileID,
              modelsDevProviderID: "openai",
            },
          },
        },
        includeLive: true,
        forceRefresh: true,
      })
      await waitForEnvironmentDiscovery(environmentProfileID)
      await Bun.sleep(20)
    },
  })

  expect(environmentDiscoveryByProvider.has(mappedProviderID)).toBe(false)
})

test("configured inline credentials participate in live discovery", async () => {
  const configured = {
    profile: environmentProfileID,
    modelsDevProviderID: "openai",
    options: {
      apiKey: "inline-catalog-key",
    },
  }
  await using tmp = await tmpdir()
  await Auth.set(inlineProviderID, {
    type: "api",
    key: "stored-catalog-key",
  })

  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      await ProviderCatalog.resolve({
        config: {
          provider: {
            [inlineProviderID]: configured,
          },
        },
        includeLive: true,
        forceRefresh: true,
      })
      await waitForEnvironmentDiscovery(inlineProviderID)
      await ProviderCatalog.refresh(inlineProviderID, environmentProfileID, undefined, configured)
    },
  })
  expect(environmentDiscoveryByProvider.get(inlineProviderID)).toBe("inline-catalog-key")
  expect(await Bun.file(Global.Path.providerModelCatalogCache).text()).not.toContain("inline-catalog-key")
})

test("catalog-only account projections are isolated by configuration", async () => {
  const first = await ProviderCatalog.resolve({
    config: {
      provider: {
        "catalog-account-a": {
          modelsDevProviderID: "openai",
          name: "Catalog Account A",
        },
      },
    },
  })
  expect(first["catalog-account-a"]?.name).toBe("Catalog Account A")

  const second = await ProviderCatalog.resolve({
    config: {
      provider: {
        "catalog-account-b": {
          modelsDevProviderID: "anthropic",
          name: "Catalog Account B",
        },
      },
    },
  })
  expect(second["catalog-account-b"]?.name).toBe("Catalog Account B")
  expect(second["catalog-account-a"]).toBeUndefined()
})

test("catalog-only projections apply model rules without exposing inline credentials", async () => {
  const accountID = "catalog-account-rules"
  const first = await ProviderCatalog.resolve({
    config: {
      provider: {
        [accountID]: {
          modelsDevProviderID: "openai",
          whitelist: ["gpt-5.5", "account-alias"],
          blacklist: ["gpt-5.5"],
          models: {
            "account-alias": {
              id: "gpt-5.5",
              name: "Account Alias",
              options: {
                apiKey: "must-not-be-projected",
                headers: {
                  Authorization: "must-not-be-projected",
                  "X-API-Key": "must-not-be-projected",
                },
                apiToken: "must-not-be-projected",
                sessionToken: "must-not-be-projected",
                accessKeyId: "must-not-be-projected",
                secretAccessKey: "must-not-be-projected",
                key: "must-not-be-projected",
                credentials: "must-not-be-projected",
                maxTokens: 16_384,
                reasoningEffort: "high",
              },
            },
          },
        },
      },
    },
  })

  expect(Object.keys(first[accountID].models)).toEqual(["account-alias"])
  expect(first[accountID].models["account-alias"].name).toBe("Account Alias")
  expect(first[accountID].models["account-alias"].id).toBe("account-alias")
  expect(first[accountID].models["account-alias"].options).toEqual({
    headers: {},
    maxTokens: 16_384,
    reasoningEffort: "high",
  })
  expect(JSON.stringify(first[accountID])).not.toContain("must-not-be-projected")

  const second = await ProviderCatalog.resolve({
    config: {
      provider: {
        [accountID]: {
          modelsDevProviderID: "openai",
          whitelist: ["gpt-5.4"],
        },
      },
    },
  })
  expect(second[accountID].models["gpt-5.4"]).toBeDefined()
  expect(second[accountID].models["account-alias"]).toBeUndefined()
})

test("catalog state is isolated between scopes that reuse a provider ID", async () => {
  await using first = await tmpdir()
  await using second = await tmpdir()
  const firstScope = await first.scope()
  const secondScope = await second.scope()

  identity = "scope-a"
  fetchCatalog = async () => [{ id: "scope-a-model" }]
  await ScopeContext.provide({
    scope: firstScope,
    fn: () => ProviderCatalog.refresh(providerID),
  })

  identity = "scope-b"
  fetchCatalog = async () => [{ id: "scope-b-model" }, { id: "scope-b-model-2" }]
  await ScopeContext.provide({
    scope: secondScope,
    fn: () => ProviderCatalog.refresh(providerID),
  })

  expect(
    await ScopeContext.provide({
      scope: firstScope,
      fn: () => ProviderCatalog.modelCatalogState(providerID)?.modelCount,
    }),
  ).toBe(1)
  expect(
    await ScopeContext.provide({
      scope: secondScope,
      fn: () => ProviderCatalog.modelCatalogState(providerID)?.modelCount,
    }),
  ).toBe(2)
})

test("reconnecting a provider does not reuse the previous credential's catalog", async () => {
  const originalNow = Date.now
  Date.now = () => 1_000
  try {
    await Auth.set(credentialProviderID, { type: "api", key: "account-a-key" })
    await ProviderCatalog.refresh(credentialProviderID)

    await Auth.set(credentialProviderID, { type: "api", key: "account-b-key" })
    await ProviderCatalog.refresh(credentialProviderID)

    const persisted = await Bun.file(Global.Path.providerModelCatalogCache).text()
    expect(persisted).not.toContain("account-a-key")
    expect(persisted).not.toContain("account-b-key")

    ProviderCatalog.reset()
    const accountB = await ProviderCatalog.resolve({ config, includeLive: true })
    expect(accountB[credentialProviderID].models["model-b"].catalog_state).toBe("active")
    expect(accountB[credentialProviderID].models["model-a"]).toBeUndefined()
  } finally {
    Date.now = originalNow
  }
})

test("retry delays are deterministic and honor Retry-After", () => {
  expect(ProviderCatalog.retryDelay({ failure: "network" })).toBe(60_000)
  expect(ProviderCatalog.retryDelay({ failure: "rate_limited", retryAfterMs: 125_000 })).toBe(125_000)
})

test("snapshot timestamps use the current attempt time", async () => {
  const originalNow = Date.now
  Date.now = () => 1_234_567
  try {
    fetchCatalog = async () => [{ id: "model-timestamped" }]
    await ProviderCatalog.refresh(providerID)
    const persisted = JSON.parse(await Bun.file(Global.Path.providerModelCatalogCache).text())
    expect(persisted.snapshots[0]).toMatchObject({ lastAttemptAt: 1_234_567, lastVerifiedAt: 1_234_567 })
  } finally {
    Date.now = originalNow
  }
})

test("corrupt snapshots are ignored and replaced by the next successful refresh", async () => {
  await fs.mkdir(Global.Path.cache, { recursive: true })
  await Bun.write(Global.Path.providerModelCatalogCache, "{not json")
  ProviderCatalog.reset()
  fetchCatalog = async () => [{ id: "model-after-corruption" }]
  await ProviderCatalog.refresh(providerID)
  expect(JSON.parse(await Bun.file(Global.Path.providerModelCatalogCache).text()).version).toBe(1)
  expect((await fs.readdir(Global.Path.cache)).some((name) => name.endsWith(".tmp"))).toBe(false)
})

test("snapshot capacity is bounded while the current identity remains available", async () => {
  fetchCatalog = async () => [{ id: "model-current" }]
  for (let index = 0; index <= ProviderCatalog.MAX_SNAPSHOT_ENTRIES; index++) {
    identity = `identity-${index}`
    await ProviderCatalog.refresh(providerID)
  }

  const persisted = JSON.parse(await Bun.file(Global.Path.providerModelCatalogCache).text())
  expect(persisted.snapshots).toHaveLength(ProviderCatalog.MAX_SNAPSHOT_ENTRIES)

  ProviderCatalog.reset()
  const current = await ProviderCatalog.resolve({ config, includeLive: true })
  expect(current[providerID].models["model-current"].catalog_state).toBe("active")
})
