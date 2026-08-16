import { expect, test } from "bun:test"
import fs from "fs/promises"
import { Global } from "../../src/global"
import { ProviderCatalog } from "../../src/provider/catalog"

const FETCH_DISABLE_ENV = "SYNERGY_DISABLE_PROVIDER_CATALOG_FETCH"

const remoteCatalog = {
  version: 1,
  providers: {
    "seed-provider": { id: "seed-provider", name: "Seed Provider" },
  },
}

function configFor(url: string, cacheTtlMs: number) {
  return {
    providerCatalog: {
      enabled: true,
      // The registry URL must be a path so the ".sig" suffix produces a valid URL.
      registryUrl: `${url}/catalog.json`,
      publicKey: "test-public-key",
      cacheTtlMs,
      offlineCache: true,
    },
  }
}

function createProbeServer() {
  let hits = 0
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket) {
        hits++
        socket.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
        socket.end()
      },
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    get hits() {
      return hits
    },
    stop() {
      server.stop()
    },
  }
}

async function seedCache() {
  await fs.mkdir(Global.Path.cache, { recursive: true })
  await Bun.write(Global.Path.providerCatalogCache, JSON.stringify(remoteCatalog))
}

async function enableNetworkFetch() {
  delete process.env[FETCH_DISABLE_ENV]
}

async function restoreDisabledFetch() {
  process.env[FETCH_DISABLE_ENV] = "true"
}

test("fresh provider catalog cache short-circuits the network fetch", async () => {
  await enableNetworkFetch()
  const probe = createProbeServer()
  try {
    await seedCache()
    ProviderCatalog.reset()

    const started = Date.now()
    const catalog = await ProviderCatalog.resolve({
      config: configFor(probe.url, 60_000),
      forceRefresh: true,
    })
    const elapsed = Date.now() - started

    expect(catalog["seed-provider"]?.name).toBe("Seed Provider")
    expect(probe.hits).toBe(0)
    // A fresh cache must short-circuit the network fetch: if the resolve
    // still awaited the registry, the probe would be hit and this would
    // take the full fetch timeout. The 5s bound is generous for cold-start
    // plugin/model loading in the test process.
    expect(elapsed).toBeLessThan(5_000)
  } finally {
    probe.stop()
    await restoreDisabledFetch()
  }
})

test("stale catalog cache serves immediately and refreshes in the background", async () => {
  await enableNetworkFetch()
  const probe = createProbeServer()
  try {
    await seedCache()
    const old = new Date(Date.now() - 5 * 60 * 1000)
    await fs.utimes(Global.Path.providerCatalogCache, old, old)
    ProviderCatalog.reset()
    const started = Date.now()
    const catalog = await ProviderCatalog.resolve({
      config: configFor(probe.url, 60_000),
      forceRefresh: true,
    })
    const elapsed = Date.now() - started

    expect(catalog["seed-provider"]?.name).toBe("Seed Provider")
    // Stale cache serves immediately (network refresh happens in the
    // background); a blocking resolve would wait on the registry fetch.
    expect(elapsed).toBeLessThan(5_000)

    for (let attempt = 0; attempt < 100; attempt++) {
      if (probe.hits > 0) break
      await Bun.sleep(10)
    }
    expect(probe.hits).toBeGreaterThan(0)
  } finally {
    probe.stop()
    await restoreDisabledFetch()
  }
})
