import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "fs/promises"
import { Global } from "../../src/global"
import { ProviderCatalog } from "../../src/provider/catalog"
import { ProviderProfile } from "../../src/provider/profile"

const config = { providerCatalog: { enabled: false, offlineCache: false } }
const providerID = `catalog-stability-${Math.random().toString(36).slice(2)}`
let identity = "account-a"
let fetchCatalog: () => Promise<ProviderProfile.ModelCatalogEntry[]>

ProviderProfile.register({
  id: providerID,
  name: "Catalog Stability Test",
  authKind: "none",
  modelsDevProviderID: "openai",
  fallbackModels: ["gpt-5.5"],
  modelCatalogIdentity: () => identity,
  fetchModelCatalog: () => fetchCatalog(),
})

async function reset() {
  identity = "account-a"
  fetchCatalog = async () => []
  ProviderCatalog.reset()
  await fs.rm(Global.Path.providerModelCatalogCache, { force: true })
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
