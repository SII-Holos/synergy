import { describe, expect, test } from "bun:test"
import { Provider as ProviderConfig } from "../../src/config/schema"
import type { ModelsDev } from "../../src/provider/models"
import { ProviderConnection } from "../../src/provider/connection"
import { ProviderProfile } from "../../src/provider/profile"

const profileID = `connection-test-${Math.random().toString(36).slice(2)}`
const mappedConnectionID = `${profileID}-account`
const projectedProfileID = `${profileID}-projected`
const projectedSourceID = `${profileID}-source`
const noEnvProfileID = `${profileID}-no-env`
const envName = `SYNERGY_TEST_CONNECTION_${profileID.toUpperCase().replace(/-/g, "_")}`

const runtimeOptionsAuth: { value?: string } = {}

ProviderProfile.register({
  id: profileID,
  name: "Connection Test Provider",
  authKind: "api_key",
  aiSdkPackage: "@ai-sdk/openai-compatible",
  env: [envName],
  baseURL: "https://profile.invalid/v1",
  modelOptions: async () => ({ baseURL: "https://profile.invalid/v1", apiKey: "profile-model-key" }),
  runtimeOptions: async ({ auth }) => {
    runtimeOptionsAuth.value = auth?.type === "api" ? auth.key : undefined
    return { temperature: 0.2 }
  },
  resolveAuth: async () => undefined,
})

ProviderProfile.register({
  id: projectedProfileID,
  name: "Projected Connection Test Provider",
  modelsDevProviderID: projectedSourceID,
})

ProviderProfile.register({
  id: noEnvProfileID,
  name: "No-env Connection Test Provider",
})

function catalogSource(models: Record<string, ModelsDev.Model>): ModelsDev.Provider {
  return {
    id: profileID,
    name: "Catalog Source",
    env: [],
    api: "https://catalog.invalid/v1",
    npm: "@ai-sdk/openai-compatible",
    models,
  }
}
function catalogs(
  runtime: Record<string, ModelsDev.Provider> = {},
  inherited: Record<string, ModelsDev.Provider> = runtime,
): ProviderConnection.CatalogSet {
  return { runtime, inherited }
}

function model(id: string, extra?: Partial<ModelsDev.Model>): ModelsDev.Model {
  return {
    id,
    name: id,
    family: "test",
    release_date: "2026-01-01",
    attachment: false,
    reasoning: false,
    temperature: false,
    tool_call: true,
    cost: { input: 1, output: 2 },
    limit: { context: 128000, input: 96000, output: 32000 },
    options: {},
    ...extra,
  }
}

async function compose(input: ProviderConnection.ComposeInput) {
  const result = await ProviderConnection.composeProviderSpec(input)
  if (!result.ok) throw new Error(`unexpected composition failure: ${result.reason}`)
  return result.spec
}

describe("ProviderConnection.resolveConnection", () => {
  test("canonical provider config does not expose profile mapping before runtime consumers migrate", () => {
    expect(ProviderConfig.safeParse({ profile: profileID }).success).toBe(false)
  })

  test("maps a configured connection to its profile and inherits profile env/baseURL", () => {
    const result = ProviderConnection.resolveConnection(
      mappedConnectionID,
      {
        provider: { [mappedConnectionID]: { profile: profileID } },
      },
      catalogs(),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.connection.profile?.id).toBe(profileID)
    expect(result.connection.isMapped).toBe(true)
    expect(result.connection.catalogSourceID).toBe(profileID)
    expect(result.connection.profileID).toBe(profileID)
    expect(result.connection.env).toEqual([envName])
    expect(result.connection.baseURL).toBe("https://profile.invalid/v1")
  })

  test("explicit modelsDevProviderID wins over profile catalog source", () => {
    const result = ProviderConnection.resolveConnection(
      mappedConnectionID,
      {
        provider: {
          [mappedConnectionID]: { profile: profileID, modelsDevProviderID: "other-catalog" },
        },
      },
      catalogs({}, { "other-catalog": catalogSource({}) }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.connection.catalogSourceID).toBe("other-catalog")
  })

  test("profile mappings use the profile's projected catalog entry", () => {
    const result = ProviderConnection.resolveConnection(
      mappedConnectionID,
      {
        provider: { [mappedConnectionID]: { profile: projectedProfileID } },
      },
      catalogs(),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.connection.catalogSourceID).toBe(projectedProfileID)
  })

  test("configured env overrides profile env", () => {
    const result = ProviderConnection.resolveConnection(
      mappedConnectionID,
      {
        provider: { [mappedConnectionID]: { profile: profileID, env: ["CUSTOM_ENV"] } },
      },
      catalogs(),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.connection.env).toEqual(["CUSTOM_ENV"])
  })

  test("baseURL precedence: options.baseURL > api > profile.baseURL", () => {
    const fromOptions = ProviderConnection.resolveConnection(
      mappedConnectionID,
      {
        provider: {
          [mappedConnectionID]: { profile: profileID, options: { baseURL: "https://options.invalid/v1" } },
        },
      },
      catalogs(),
    )
    if (!fromOptions.ok) throw new Error("expected ok")
    expect(fromOptions.connection.baseURL).toBe("https://options.invalid/v1")

    const fromApi = ProviderConnection.resolveConnection(
      mappedConnectionID,
      {
        provider: { [mappedConnectionID]: { profile: profileID, api: "https://api.invalid/v1" } },
      },
      catalogs(),
    )
    if (!fromApi.ok) throw new Error("expected ok")
    expect(fromApi.connection.baseURL).toBe("https://api.invalid/v1")
  })

  test("unknown configured profile is an explicit failure, not silent degradation", () => {
    const result = ProviderConnection.resolveConnection(
      mappedConnectionID,
      {
        provider: { [mappedConnectionID]: { profile: "does-not-exist" } },
      },
      catalogs(),
    )
    expect(result).toEqual({
      ok: false,
      reason: "unknown_profile",
      connectionID: mappedConnectionID,
      profileID: "does-not-exist",
    })
  })

  test("plain provider without config resolves to its canonical profile", () => {
    const result = ProviderConnection.resolveConnection(profileID, undefined, catalogs())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.connection.isMapped).toBe(false)
    expect(result.connection.profileID).toBe(profileID)
    expect(result.connection.catalogSourceID).toBe(profileID)
  })

  test("resolveAllConnections includes canonical profiles and configured connections", () => {
    const all = ProviderConnection.resolveAllConnections(
      {
        provider: { [mappedConnectionID]: { profile: profileID } },
      },
      catalogs(),
    )
    expect(all.ok).toBe(true)
    if (!all.ok) return
    expect(all.connections[profileID]?.isMapped).toBe(false)
    expect(all.connections[mappedConnectionID]?.isMapped).toBe(true)
  })

  test("resolveAllConnections propagates invalid configured profiles", () => {
    const all = ProviderConnection.resolveAllConnections(
      {
        provider: { [mappedConnectionID]: { profile: "does-not-exist" } },
      },
      catalogs(),
    )
    expect(all).toEqual({
      ok: false,
      failures: [
        {
          ok: false,
          reason: "unknown_profile",
          connectionID: mappedConnectionID,
          profileID: "does-not-exist",
        },
      ],
    })
  })
  test("resolves canonical environment and base URL from the catalog", () => {
    const connectionID = `${profileID}-catalog-resolved`
    const source = {
      ...catalogSource({ "model-a": model("model-a") }),
      id: connectionID,
      env: [envName],
    }

    const result = ProviderConnection.resolveConnection(connectionID, undefined, catalogs({ [connectionID]: source }))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.connection.env).toEqual([envName])
    expect(result.connection.baseURL).toBe("https://catalog.invalid/v1")
  })
})

describe("ProviderConnection.composeProviderSpec", () => {
  test("projects the catalog source onto the connection ID and applies model rules", async () => {
    const connection = ProviderConnection.resolveConnection(
      mappedConnectionID,
      {
        provider: {
          [mappedConnectionID]: {
            profile: profileID,
            whitelist: ["model-a", "model-renamed"],
            models: {
              "model-renamed": { id: "model-b", name: "Renamed B" },
            },
          },
        },
      },
      catalogs(),
    )
    if (!connection.ok) throw new Error("expected ok")

    const spec = await compose({
      connection: connection.connection,
      catalogs: catalogs({
        [profileID]: catalogSource({
          "model-a": model("model-a"),
          "model-b": model("model-b"),
          "model-c": model("model-c"),
        }),
      }),
    })

    expect(spec.providerID).toBe(mappedConnectionID)
    expect(spec.catalogSource?.id).toBe(mappedConnectionID)
    expect(Object.keys(spec.models).sort()).toEqual(["model-a", "model-renamed"])
    expect(spec.models["model-renamed"].id).toBe("model-renamed")
    expect(spec.modelApiIDs["model-renamed"]).toBe("model-b")
    expect(spec.models["model-renamed"].name).toBe("Renamed B")
  })

  test("explicit upstream model ids win while catalog metadata is retained", async () => {
    const connection = ProviderConnection.resolveConnection(
      mappedConnectionID,
      {
        provider: {
          [mappedConnectionID]: {
            profile: profileID,
            models: {
              "model-a": { id: "deployment-123", name: "Deployment A" },
            },
          },
        },
      },
      catalogs(),
    )
    if (!connection.ok) throw new Error("expected ok")

    const spec = await compose({
      connection: connection.connection,
      catalogs: catalogs({ [profileID]: catalogSource({ "model-a": model("model-a", { reasoning: true }) }) }),
    })

    expect(spec.modelApiIDs["model-a"]).toBe("deployment-123")
    expect(spec.models["model-a"].reasoning).toBe(true)
    expect(spec.models["model-a"].name).toBe("Deployment A")
  })

  test("connection overrides win over profile runtime options", async () => {
    const connection = ProviderConnection.resolveConnection(
      mappedConnectionID,
      {
        provider: {
          [mappedConnectionID]: {
            profile: profileID,
            options: { temperature: 0.9, baseURL: "https://connection.invalid/v1" },
          },
        },
      },
      catalogs(),
    )
    if (!connection.ok) throw new Error("expected ok")

    const spec = await compose({
      connection: connection.connection,
      catalogs: catalogs({ [profileID]: catalogSource({ "model-a": model("model-a") }) }),
      auth: { type: "api", key: "connection-key" },
    })

    expect(spec.options.temperature).toBe(0.9)
    expect(spec.options.baseURL).toBe("https://connection.invalid/v1")
    expect(spec.explicitOptions).toEqual({ temperature: 0.9, baseURL: "https://connection.invalid/v1" })
  })

  test("profile runtime options see the connection auth and connection-scoped providerID", async () => {
    runtimeOptionsAuth.value = undefined
    const connection = ProviderConnection.resolveConnection(
      mappedConnectionID,
      {
        provider: { [mappedConnectionID]: { profile: profileID } },
      },
      catalogs(),
    )
    if (!connection.ok) throw new Error("expected ok")

    await compose({
      connection: connection.connection,
      catalogs: catalogs({ [profileID]: catalogSource({ "model-a": model("model-a") }) }),
      auth: { type: "api", key: "connection-key" },
    })

    expect(runtimeOptionsAuth.value!).toBe("connection-key")
  })
  test("an explicit missing catalog source returns a typed failure", () => {
    const connection = ProviderConnection.resolveConnection(
      mappedConnectionID,
      {
        provider: {
          [mappedConnectionID]: { profile: profileID, modelsDevProviderID: "missing-catalog-source" },
        },
      },
      catalogs(),
    )

    expect(connection).toEqual({
      ok: false,
      reason: "unknown_catalog_source",
      connectionID: mappedConnectionID,
      catalogSourceID: "missing-catalog-source",
    })
  })

  test("composition rejects a stale definition with a missing inherited source", async () => {
    const source = catalogSource({ "model-a": model("model-a") })
    const resolved = ProviderConnection.resolveConnection(
      mappedConnectionID,
      {
        provider: {
          [mappedConnectionID]: { profile: profileID, modelsDevProviderID: profileID },
        },
      },
      catalogs({}, { [profileID]: source }),
    )
    if (!resolved.ok) throw new Error("expected ok")

    const result = await ProviderConnection.composeProviderSpec({
      connection: resolved.connection,
      catalogs: catalogs(),
    })

    expect(result).toEqual({
      ok: false,
      reason: "unknown_catalog_source",
      connectionID: mappedConnectionID,
      catalogSourceID: profileID,
    })
  })

  test("canonical catalog providers preserve their source environment", async () => {
    const connectionID = `${profileID}-catalog-only`
    const source = { ...catalogSource({ "model-a": model("model-a") }), id: connectionID, env: [envName] }
    const catalogSet = catalogs({ [connectionID]: source })
    const connection = ProviderConnection.resolveConnection(connectionID, undefined, catalogSet)
    if (!connection.ok) throw new Error("expected ok")

    const spec = await compose({
      connection: connection.connection,
      catalogs: catalogSet,
    })

    expect(spec.env).toEqual([envName])
    expect(spec.catalogSource?.env).toEqual([envName])
  })

  test("mapped profiles do not inherit canonical catalog environment keys", async () => {
    const connectionID = `${noEnvProfileID}-account`
    const connection = ProviderConnection.resolveConnection(
      connectionID,
      {
        provider: { [connectionID]: { profile: noEnvProfileID } },
      },
      catalogs(),
    )
    if (!connection.ok) throw new Error("expected ok")
    const source = {
      ...catalogSource({ "model-a": model("model-a") }),
      id: noEnvProfileID,
      env: ["CANONICAL_PROVIDER_API_KEY"],
    }

    const spec = await compose({
      connection: connection.connection,
      catalogs: catalogs({ [noEnvProfileID]: source }),
    })

    expect(spec.env).toEqual([])
    expect(spec.catalogSource?.env).toEqual([])
  })
  test("explicit catalog inheritance excludes credential-scoped live models", async () => {
    const connectionID = `${profileID}-static-inheritance`
    const connection = ProviderConnection.resolveConnection(
      connectionID,
      {
        provider: {
          [connectionID]: { modelsDevProviderID: profileID, env: [envName] },
        },
      },
      catalogs({}, { [profileID]: catalogSource({ "model-static": model("model-static") }) }),
    )
    if (!connection.ok) throw new Error("expected ok")

    const spec = await compose({
      connection: connection.connection,
      catalogs: catalogs(
        { [profileID]: catalogSource({ "model-live-private": model("model-live-private") }) },
        { [profileID]: catalogSource({ "model-static": model("model-static") }) },
      ),
    })

    expect(Object.keys(spec.models)).toEqual(["model-static"])
  })

  test("connection npm overrides inherited model transport metadata", async () => {
    const connectionID = `${profileID}-npm-override`
    const inheritedModel = model("model-a", { provider: { npm: "@ai-sdk/anthropic" } })
    const inheritedSource = {
      ...catalogSource({ "model-a": inheritedModel }),
      npm: "@ai-sdk/anthropic",
    }
    const connection = ProviderConnection.resolveConnection(
      connectionID,
      {
        provider: {
          [connectionID]: {
            modelsDevProviderID: profileID,
            npm: "@ai-sdk/openai-compatible",
          },
        },
      },
      catalogs({}, { [profileID]: inheritedSource }),
    )
    if (!connection.ok) throw new Error("expected ok")

    const spec = await compose({
      connection: connection.connection,
      catalogs: catalogs({}, { [profileID]: inheritedSource }),
    })

    expect(spec.models["model-a"].provider?.npm).toBe("@ai-sdk/openai-compatible")
  })

  test("config-only fallback models preserve text modalities", async () => {
    const connectionID = `${profileID}-config-only`
    const connection = ProviderConnection.resolveConnection(
      connectionID,
      {
        provider: {
          [connectionID]: {
            api: "https://config.invalid/v1",
            npm: "@ai-sdk/openai-compatible",
            models: { "model-custom": { name: "Custom model" } },
          },
        },
      },
      catalogs(),
    )
    if (!connection.ok) throw new Error("expected ok")

    const spec = await compose({ connection: connection.connection, catalogs: catalogs() })

    expect(spec.models["model-custom"].modalities).toEqual({ input: ["text"], output: ["text"] })
  })
})

describe("ProviderConnection.ConnectionStateManager", () => {
  test("eviction protects active connections and evicts inactive LRU entries", () => {
    const manager = new ProviderConnection.ConnectionStateManager(2)
    manager.register("conn-a", "key-a1")
    manager.register("conn-b", "key-b1")

    manager.set("conn-a", "key-a1", { v: 1 }, 100)
    manager.set("conn-b", "key-b1", { v: 2 }, 200)
    // Third entry pushes over capacity (3 > 2); only conn-c is inactive → evicted.
    manager.set("conn-c", "key-c1", { v: 3 }, 300)

    const protectedKeys = manager.protectedKeys()
    expect(protectedKeys.has("key-a1")).toBe(true)
    expect(protectedKeys.has("key-b1")).toBe(true)
    expect(protectedKeys.has("key-c1")).toBe(false)

    expect(manager.has("key-a1")).toBe(true)
    expect(manager.has("key-b1")).toBe(true)
    expect(manager.has("key-c1")).toBe(false)
  })

  test("only the current snapshot of an active connection is protected", () => {
    const manager = new ProviderConnection.ConnectionStateManager(2)
    manager.register("conn-a", "a2")
    manager.register("conn-b", "b1")
    manager.set("conn-a", "a1", {}, 100)
    manager.set("conn-b", "b1", {}, 200)
    manager.set("conn-a", "a2", {}, 300)

    expect(manager.has("a1")).toBe(false)
    expect(manager.has("a2")).toBe(true)
    expect(manager.has("b1")).toBe(true)
  })
  test("unregistering a connection makes its snapshots evictable", () => {
    const manager = new ProviderConnection.ConnectionStateManager(1)
    manager.register("conn-a", "a1")
    manager.set("conn-a", "a1", {}, 100)
    expect(manager.evict()).toEqual([])

    manager.unregister("conn-a")
    // New entry pushes over capacity; the inactive conn-a entry is the oldest → evicted.
    manager.set("conn-b", "b1", {}, 200)
    expect(manager.has("a1")).toBe(false)
    expect(manager.has("b1")).toBe(true)
  })

  test("invalidating a connection clears its snapshots and active registration", () => {
    const manager = new ProviderConnection.ConnectionStateManager(2)
    manager.register("conn-a", "a2")
    manager.set("conn-a", "a1", {}, 100)
    manager.set("conn-a", "a2", {}, 200)

    expect(manager.invalidate("conn-a").sort()).toEqual(["a1", "a2"])
    expect(manager.isActive("conn-a")).toBe(false)
    expect(manager.has("a1")).toBe(false)
    expect(manager.has("a2")).toBe(false)
  })
})
