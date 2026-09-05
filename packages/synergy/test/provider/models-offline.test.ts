import { expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { prepareBuildModelsCatalog } from "../../script/models-catalog"

const packageRoot = path.resolve(import.meta.dir, "../..")
const fixtures = path.join(import.meta.dir, "fixtures")
const fixtureRoot = process.env.SYNERGY_TEST_ROOT!

function catalog(providerID: string, name: string) {
  return {
    [providerID]: {
      id: providerID,
      name,
      env: [] as string[],
      models: {
        "test-model": {
          id: "test-model",
          name: "Test model",
          release_date: "2026-01-01",
          attachment: false,
          reasoning: false,
          tool_call: true,
          limit: { context: 4096, output: 1024 },
        },
      },
    },
  }
}
function catalogWithModelProvider(providerID: string, name: string, provider: { npm?: string }) {
  const result = catalog(providerID, name)
  return {
    [providerID]: {
      ...result[providerID],
      models: {
        "test-model": {
          ...result[providerID].models["test-model"],
          provider,
        },
      },
    },
  }
}

function completeCatalog(...catalogs: Array<ReturnType<typeof catalog>>) {
  return Object.assign(
    {
      ...catalog("openai", "OpenAI"),
      ...catalog("anthropic", "Anthropic"),
      ...catalog("google", "Google"),
    },
    ...catalogs,
  )
}

function connectedCatalog(providerID: string, name: string, env: string) {
  return completeCatalog({
    [providerID]: {
      ...catalog(providerID, name)[providerID],
      env: [env],
    },
  })
}

async function tempdir(name: string) {
  return fs.mkdtemp(path.join(fixtureRoot, `${name}-`))
}

function isolatedEnv(home: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    SYNERGY_HOME: home,
    SYNERGY_DISABLE_MODELS_FETCH: "1",
    SYNERGY_DISABLE_DEFAULT_PLUGINS: "1",
    SYNERGY_DISABLE_LSP_DOWNLOAD: "1",
    SYNERGY_DISABLE_FILEWATCHER: "1",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
  }
  delete env.SYNERGY_TEST_HOME
  delete env.MODELS_DEV_API_JSON
  return env
}

async function runProcess(command: string[], env: Record<string, string | undefined>) {
  const child = Bun.spawn(command, {
    cwd: packageRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(exitCode, stderr).toBe(0)
  return { stdout, stderr }
}

async function runJSON(command: string[], env: Record<string, string | undefined>) {
  const result = await runProcess(command, env)
  return JSON.parse(result.stdout)
}

test("models macro disables network fetch and falls back to an empty catalog", async () => {
  const home = await tempdir("models-macro-empty")
  const result = await runJSON(
    [process.execPath, "run", path.join(fixtures, "models-macro-offline.ts")],
    isolatedEnv(home),
  )

  expect(result.requests).toBe(0)
  expect(result.providerIDs).toEqual([])
})

test("models macro resolves the cache from SYNERGY_HOME before SYNERGY_TEST_HOME", async () => {
  const home = await tempdir("models-macro-home")
  const testHome = await tempdir("models-macro-test-home")
  const expected = catalog("home-cache", "Home cache")
  const cachePath = path.join(home, ".synergy", "cache", "models.json")
  await fs.mkdir(path.dirname(cachePath), { recursive: true })
  await Bun.write(cachePath, JSON.stringify(expected))

  const env = isolatedEnv(home)
  env.SYNERGY_TEST_HOME = testHome
  const result = await runJSON([process.execPath, "run", path.join(fixtures, "models-macro-offline.ts")], env)

  expect(result).toEqual({ requests: 0, providerIDs: ["home-cache"] })
})

test("models macro falls back when the response body cannot be read", async () => {
  const home = await tempdir("models-macro-body-error")
  const cachePath = path.join(home, ".synergy", "cache", "models.json")
  await fs.mkdir(path.dirname(cachePath), { recursive: true })
  await Bun.write(cachePath, JSON.stringify(catalog("cached-provider", "Cached provider")))
  const env = isolatedEnv(home)
  delete env.SYNERGY_DISABLE_MODELS_FETCH

  const result = await runJSON(
    [process.execPath, "run", path.join(fixtures, "models-macro-offline.ts"), "body-error"],
    env,
  )

  expect(result).toEqual({ requests: 1, providerIDs: ["cached-provider"] })
})

test("models macro ignores an unreadable local cache", async () => {
  const home = await tempdir("models-macro-cache-error")
  await fs.mkdir(path.join(home, ".synergy", "cache", "models.json"), { recursive: true })

  const result = await runJSON(
    [process.execPath, "run", path.join(fixtures, "models-macro-offline.ts")],
    isolatedEnv(home),
  )

  expect(result).toEqual({ requests: 0, providerIDs: [] })
})

test.each([
  ["empty catalog", {}],
  [
    "providers without models",
    {
      empty: { id: "empty", name: "Empty", env: [], models: {} },
      "also-empty": { id: "also-empty", name: "Also empty", env: [], models: {} },
    },
  ],
  ["partial catalog", catalog("partial-provider", "Partial provider")],
  ["null provider", { broken: null }],
  ["null model", { broken: { id: "broken", name: "Broken", env: [], models: { bad: null } } }],
  [
    "malformed model",
    {
      broken: {
        id: "broken",
        name: "Broken",
        env: [],
        models: { bad: { id: "bad", name: "Bad", release_date: "2026-01-01" } },
      },
    },
  ],
])("invalid refreshed catalog preserves the last valid cache for %s", async (_name, payload) => {
  const home = await tempdir("models-invalid-refresh")
  const project = await tempdir("models-invalid-refresh-project")
  const env = isolatedEnv(home)
  delete env.SYNERGY_DISABLE_MODELS_FETCH
  env.MODELS_OFFLINE_PROJECT = project
  env.INITIAL_PROVIDER_KEY = "initial-key"
  env.MODELS_INITIAL_PAYLOAD = JSON.stringify(
    connectedCatalog("initial-provider", "Initial provider", "INITIAL_PROVIDER_KEY"),
  )
  env.MODELS_REFRESH_PAYLOAD = JSON.stringify(payload)

  const result = await runJSON(
    [process.execPath, "run", path.join(fixtures, "models-runtime-offline.ts"), "invalid-refresh"],
    env,
  )

  expect(result.memoryProviders).toEqual(expect.arrayContaining(["initial-provider", "openai", "anthropic", "google"]))
  expect(result.diskProviders).toEqual(expect.arrayContaining(["initial-provider", "openai", "anthropic", "google"]))
  expect(result.memoryProviders).not.toContain("partial-provider")
  expect(result.diskProviders).not.toContain("partial-provider")
  expect(result.providerStatus).toBe(200)
  expect(result.providerCatalogProviders).toEqual(expect.arrayContaining(["initial-provider"]))
  expect(result.bootstrapCatalogProviders).toEqual(expect.arrayContaining(["initial-provider"]))
})

test("successful refresh invalidates provider catalog and scoped provider state", async () => {
  const home = await tempdir("models-refresh-visible")
  const project = await tempdir("models-refresh-visible-project")
  const env = isolatedEnv(home)
  delete env.SYNERGY_DISABLE_MODELS_FETCH
  env.MODELS_OFFLINE_PROJECT = project
  env.INITIAL_PROVIDER_KEY = "initial-key"
  env.REFRESHED_PROVIDER_KEY = "refreshed-key"
  env.MODELS_INITIAL_PAYLOAD = JSON.stringify(
    connectedCatalog("initial-provider", "Initial provider", "INITIAL_PROVIDER_KEY"),
  )
  env.MODELS_REFRESH_PAYLOAD = JSON.stringify(
    connectedCatalog("refreshed-provider", "Refreshed provider", "REFRESHED_PROVIDER_KEY"),
  )

  const result = await runJSON(
    [process.execPath, "run", path.join(fixtures, "models-runtime-offline.ts"), "refresh-routes"],
    env,
  )

  expect(result).toEqual({
    initialCatalogProviders: expect.arrayContaining(["initial-provider"]),
    initialConnected: expect.arrayContaining(["initial-provider"]),
    refreshedCatalogProviders: expect.arrayContaining(["refreshed-provider"]),
    refreshedConnected: expect.arrayContaining(["refreshed-provider"]),
    bootstrapCatalogProviders: expect.arrayContaining(["refreshed-provider"]),
    bootstrapConnected: expect.arrayContaining(["refreshed-provider"]),
    runtimeReloads: [
      {
        hasDirectory: false,
        executed: expect.arrayContaining(["provider", "agent"]),
        cascaded: expect.arrayContaining(["agent"]),
      },
    ],
  })
  expect(result.refreshedCatalogProviders).not.toContain("initial-provider")
  expect(result.refreshedConnected).not.toContain("initial-provider")
  expect(result.bootstrapConnected).not.toContain("initial-provider")
})

test("ModelsDev refresh preserves an in-flight provider discovery snapshot", async () => {
  const home = await tempdir("models-refresh-concurrent-discovery")
  const env = isolatedEnv(home)
  delete env.SYNERGY_DISABLE_MODELS_FETCH
  env.MODELS_INITIAL_PAYLOAD = JSON.stringify(completeCatalog(catalog("initial-provider", "Initial provider")))
  env.MODELS_REFRESH_PAYLOAD = JSON.stringify(completeCatalog(catalog("refreshed-provider", "Refreshed provider")))

  const result = await runJSON(
    [process.execPath, "run", path.join(fixtures, "models-runtime-offline.ts"), "refresh-during-discovery"],
    env,
  )

  expect(result.activeModels).toEqual(["discovered-model"])
})

test("ModelsDev refresh preserves freshly discovered provider state", async () => {
  const home = await tempdir("models-refresh-fresh-discovery")
  const env = isolatedEnv(home)
  delete env.SYNERGY_DISABLE_MODELS_FETCH
  env.MODELS_INITIAL_PAYLOAD = JSON.stringify(completeCatalog(catalog("initial-provider", "Initial provider")))
  env.MODELS_REFRESH_PAYLOAD = JSON.stringify(completeCatalog(catalog("refreshed-provider", "Refreshed provider")))

  const result = await runJSON(
    [process.execPath, "run", path.join(fixtures, "models-runtime-offline.ts"), "refresh-after-discovery"],
    env,
  )

  expect(result).toEqual({ sourceBefore: "live", sourceAfter: "live" })
})

test("ModelsDev cold start returns locally while refresh updates memory and disk", async () => {
  const home = await tempdir("models-refresh-home")
  const source = path.join(await tempdir("models-refresh-source"), "models.json")
  await Bun.write(source, JSON.stringify(completeCatalog(catalog("initial-provider", "Initial provider"))))
  const env = isolatedEnv(home)
  delete env.SYNERGY_DISABLE_MODELS_FETCH
  env.MODELS_DEV_API_JSON = source
  env.MODELS_INITIAL_PAYLOAD = JSON.stringify(completeCatalog(catalog("initial-provider", "Initial provider")))
  env.MODELS_REFRESH_PAYLOAD = JSON.stringify(completeCatalog(catalog("refreshed-provider", "Refreshed provider")))
  const result = await runJSON(
    [process.execPath, "run", path.join(fixtures, "models-runtime-offline.ts"), "refresh"],
    env,
  )

  expect(result.returnedBeforeRefresh).toBe(true)
  expect(result.initialProviders).toEqual(expect.arrayContaining(["initial-provider", "openai", "anthropic", "google"]))
  expect(result.memoryProviders).toEqual(
    expect.arrayContaining(["refreshed-provider", "openai", "anthropic", "google"]),
  )
  expect(result.diskProviders).toEqual(expect.arrayContaining(["refreshed-provider", "openai", "anthropic", "google"]))
  expect(result.requests).toBe(1)
})

test("fresh offline provider routes remain available without a models cache", async () => {
  const home = await tempdir("models-routes-home")
  const project = await tempdir("models-routes-project")
  const env = isolatedEnv(home)
  env.MODELS_OFFLINE_PROJECT = project
  const result = await runJSON(
    [process.execPath, "run", path.join(fixtures, "models-runtime-offline.ts"), "routes"],
    env,
  )

  expect(result.providerStatus).toBe(200)
  expect(result.bootstrapStatus).toBe(200)
  expect(result.providerCount).toBeGreaterThan(0)
  expect(result.bootstrapProviderCount).toBe(result.providerCount)
  expect(result.requests).toBe(0)
})

test("fresh provider routes load the configured catalog on cold start", async () => {
  const home = await tempdir("models-routes-configured-home")
  const project = await tempdir("models-routes-configured-project")
  const source = path.join(await tempdir("models-routes-configured-source"), "models.json")
  await Bun.write(
    source,
    JSON.stringify(completeCatalog(catalogWithModelProvider("cold-start-provider", "Cold start provider", {}))),
  )
  const env = isolatedEnv(home)
  env.MODELS_DEV_API_JSON = source
  env.MODELS_OFFLINE_PROJECT = project

  const result = await runJSON(
    [process.execPath, "run", path.join(fixtures, "models-runtime-offline.ts"), "routes"],
    env,
  )

  expect(result.providerIDs).toContain("cold-start-provider")
  expect(result.bootstrapProviderIDs).toContain("cold-start-provider")
  expect(result.requests).toBe(0)
})

test("production builds use a validated pinned models snapshot", async () => {
  const defaultEnv: Record<string, string | undefined> = {}
  const prepared = await prepareBuildModelsCatalog(defaultEnv)

  expect(prepared.providerCount).toBeGreaterThan(0)
  expect(prepared.requiredProviders).toEqual(["openai", "anthropic", "google"])
  expect(defaultEnv.MODELS_DEV_API_JSON).toBe(prepared.path)
  expect(prepared.source).toBe("pinned")

  const overridden = await prepareBuildModelsCatalog({ MODELS_DEV_API_JSON: prepared.path })
  expect(overridden.source).toBe("override")

  const home = await tempdir("models-build-pinned-home")
  const buildRoot = await tempdir("models-build-pinned")
  const output = path.join(buildRoot, "models-bundled-runtime.js")
  await runProcess(
    [process.execPath, "build", path.join(fixtures, "models-bundled-runtime.ts"), "--target=bun", "--outfile", output],
    { ...isolatedEnv(home), ...defaultEnv },
  )
  const bundled = await runJSON([process.execPath, output], isolatedEnv(home))
  expect(bundled.providers).toEqual(expect.arrayContaining(prepared.requiredProviders))

  const invalidPath = path.join(await tempdir("models-build-invalid"), "models.json")
  await Bun.write(invalidPath, "{}")
  await expect(prepareBuildModelsCatalog({ MODELS_DEV_API_JSON: invalidPath })).rejects.toThrow(
    "missing required providers",
  )
})

test("bundled runtime uses the embedded models snapshot without a runtime fetch", async () => {
  const home = await tempdir("models-bundle-home")
  const buildRoot = await tempdir("models-bundle-build")
  const source = path.join(buildRoot, "models.json")
  const output = path.join(buildRoot, "models-bundled-runtime.js")
  await Bun.write(source, JSON.stringify(completeCatalog(catalog("bundle-provider", "Bundle provider"))))

  const buildEnv = isolatedEnv(home)
  buildEnv.MODELS_DEV_API_JSON = source
  await runProcess(
    [process.execPath, "build", path.join(fixtures, "models-bundled-runtime.ts"), "--target=bun", "--outfile", output],
    buildEnv,
  )

  const result = await runJSON([process.execPath, output], isolatedEnv(home))
  expect(result.providers).toEqual(expect.arrayContaining(["bundle-provider", "openai", "anthropic", "google"]))
})
