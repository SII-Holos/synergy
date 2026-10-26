import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { parse } from "jsonc-parser"
import { migrations } from "../../src/config/migration"
import { ConfigSource } from "../../src/config/source"
import { Global } from "../../src/global"
import { upgradeImportedConfig } from "../../src/migration/import"
import { Auth } from "../../src/provider/api-key"
import { Scope } from "../../src/scope"
import { Storage } from "../../src/storage/storage"
import { testRuntime } from "../support/runtime"
import { runtimeHome } from "../support/runtime-home"
import { tmpdir } from "../support/fixture"

const configID = "20261026-retire-network-config"
const credentialID = "20261026-retire-network-credentials"
const retained = {
  providerID: "fixture",
  authKind: "api_key",
  tokens: { apiKey: "fixture-only-key" },
  updatedAt: 123,
  future: { retained: true },
}
const retired = { authKind: "holos", tokens: { agentId: "fixture", agentSecret: "fixture-only-secret" } }

async function runMigration(id: string) {
  const migration = migrations.find((entry) => entry.id === id)
  expect(migration).toBeDefined()
  await migration!.up(() => {})
}

test("fresh startup records retirement without creating credential files", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const ledger = await Storage.read<Record<string, number>>(["meta", "migration", "log-config"])
    expect(ledger[configID]).toBeGreaterThan(0)
    expect(ledger[credentialID]).toBeGreaterThan(0)
    expect(await Bun.file(Global.Path.authProvider).exists()).toBe(false)
    expect(await Auth.all()).toEqual({})
  })
})

test("retirement removes only retired credentials, including mixed pools and older auth shapes", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const poolEntry = { id: "kept", status: "active", ...retained }
    const credentials = {
      fixture: retained,
      retired: { providerID: "retired", ...retired, updatedAt: 124 },
      legacy: { providerID: "legacy", auth: { type: "holos", agentSecret: "fixture-only-secret" } },
      mixed: { ...retained, providerID: "mixed", pool: [poolEntry, { id: "retired", ...retired }] },
      unknown: { future: true },
    }
    await Bun.write(Global.Path.authProvider, JSON.stringify({ schemaVersion: 2, credentials, future: true }))
    const accounts = path.join(Global.Path.auth, "holos-accounts.json")
    await Bun.write(accounts, JSON.stringify({ accounts: [{ agentSecret: "fixture-only-secret" }] }))
    const contact = ["holos", "contacts", "fixture"]
    const mailbox = ["holos", "mailbox", "inbox", "fixture", "message"]
    await Storage.write(contact, { name: "Retained contact" })
    await Storage.write(mailbox, { text: "Retained mail" })

    await runMigration(credentialID)
    const once = await Bun.file(Global.Path.authProvider).text()
    await runMigration(credentialID)
    expect(await Bun.file(Global.Path.authProvider).text()).toBe(once)
    expect(JSON.parse(once)).toEqual({
      schemaVersion: 2,
      credentials: {
        fixture: retained,
        mixed: { ...retained, providerID: "mixed", pool: [poolEntry] },
        unknown: { future: true },
      },
      future: true,
    })
    expect(await Bun.file(accounts).exists()).toBe(false)
    expect((await fs.stat(Global.Path.authProvider)).mode & 0o777).toBe(0o600)
    expect(await Auth.get("fixture")).toMatchObject({ type: "api", key: "fixture-only-key" })
    expect(await Storage.read(contact)).toEqual({ name: "Retained contact" })
    expect(await Storage.read(mailbox)).toEqual({ text: "Retained mail" })
  })
})

test("legacy flat credential stores and their backups retain unrelated authentication", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const retained = {
      api: { type: "api", key: "fixture-api" },
      oauth: { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: 9876543210 },
    }
    const input = { ...retained, retired: { type: "holos", agentId: "fixture", agentSecret: "fixture-secret" } }
    for (const file of [Global.Path.authApiKey, `${Global.Path.authApiKey}.bak`])
      await Bun.write(file, JSON.stringify(input))
    await runMigration(credentialID)
    for (const file of [Global.Path.authApiKey, `${Global.Path.authApiKey}.bak`]) {
      expect(await Bun.file(file).json()).toEqual(retained)
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    }
  })
})

test("a retired primary credential preserves and promotes unrelated pool credentials", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const poolEntry = { id: "kept", status: "active", ...retained }
    const legacyAuth = {
      type: "oauth",
      access: "fixture-access",
      refresh: "fixture-refresh",
      expires: 9876543210,
    } satisfies Auth.Info
    const legacyPool = { id: "legacy-kept", status: "active", auth: legacyAuth, updatedAt: 123 }
    await Bun.write(
      Global.Path.authProvider,
      JSON.stringify({
        schemaVersion: 2,
        credentials: {
          mixed: {
            providerID: "mixed",
            ...retired,
            metadata: { agentSecret: "retired-secret" },
            pool: [{ id: "retired", ...retired }, poolEntry],
            future: true,
          },
          legacy: {
            providerID: "legacy",
            authKind: "holos",
            auth: { type: "holos", agentSecret: "retired-secret" },
            updatedAt: 100,
            pool: [legacyPool],
          },
        },
      }),
    )
    await runMigration(credentialID)
    const data = await Bun.file(Global.Path.authProvider).json()
    expect(data.credentials.mixed).toEqual({
      providerID: "mixed",
      authKind: "api_key",
      tokens: retained.tokens,
      updatedAt: 123,
      pool: [poolEntry],
      future: true,
    })
    expect(data.credentials.legacy).toEqual({
      providerID: "legacy",
      auth: legacyAuth,
      updatedAt: 123,
      pool: [legacyPool],
    })
    expect(await Auth.get("mixed")).toMatchObject({ type: "api", key: "fixture-only-key" })
    expect(await Auth.get("legacy")).toEqual(legacyAuth)
    const once = await Bun.file(Global.Path.authProvider).text()
    await runMigration(credentialID)
    expect(await Bun.file(Global.Path.authProvider).text()).toBe(once)
  })
})

test("retirement preserves unrelated config and comments across global, project, config sets and imports", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using project = await tmpdir({ git: true })
    await Scope.fromDirectory(project.path)
    const files = [
      path.join(Global.Path.config, "synergy.jsonc"),
      path.join(Global.Path.config, "synergy.d", "100-holos.jsonc"),
      path.join(Global.Path.config, "config-sets", "fixture", "synergy.jsonc"),
      path.join(project.path, ".synergy", "synergy.d", "060-channel.jsonc"),
    ]
    const input = {
      holos: { enabled: true },
      holos_friend_reply_model: "fixture/model",
      channel: {
        holos: { enabled: true },
        clarus: { type: "clarus", accounts: { default: { enabled: true } } },
        renamed: { type: "clarus", accounts: {} },
        feishu: { type: "feishu", accounts: { retained: { enabled: false } } },
        future: { untouched: true },
      },
      unknown: { retained: true },
    }
    const expected = { channel: { feishu: input.channel.feishu, future: input.channel.future }, unknown: input.unknown }
    for (const file of files) await Bun.write(file, `// retained comment\n${JSON.stringify(input)}`)
    const features = path.join(Global.Path.config, "synergy.d", "140-features.jsonc")
    await Bun.write(features, '{ "features": { "optIn": ["holos", "boss", "channel-clarus", "unknown"] } }')
    await runMigration(configID)
    await runMigration(configID)
    for (const file of files) {
      const raw = await Bun.file(file).text()
      expect(parse(raw)).toEqual(expected)
      expect(raw).toContain("// retained comment")
    }
    expect(parse(await Bun.file(features).text())).toEqual({ features: { optIn: ["boss", "unknown"] } })
    expect(upgradeImportedConfig(input)).toEqual(expected)
    expect(input.holos.enabled).toBe(true)
  })
})

test("invalid credential files fail without deleting the source or account secrets", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const accounts = path.join(Global.Path.auth, "holos-accounts.json")
    await Bun.write(accounts, "fixture-account")
    await Bun.write(Global.Path.authProvider, "{broken")
    await expect(runMigration(credentialID)).rejects.toThrow()
    expect(await Bun.file(Global.Path.authProvider).text()).toBe("{broken")
    expect(await Bun.file(accounts).text()).toBe("fixture-account")
  })
})

test("exclusive configuration hosts still retire credentials while file configuration remains pending", async () => {
  await using home = await runtimeHome()
  const config = path.join(home.host.root, "config", "synergy.jsonc")
  const auth = path.join(home.host.root, "data", "auth", "provider-auth.json")
  const raw = '{ "holos": { "enabled": true } }'
  await Bun.write(config, raw)
  await Bun.write(auth, JSON.stringify({ schemaVersion: 2, credentials: { fixture: retained, retired } }))
  await using runtime = await testRuntime({
    home: home.host.home,
    register: () => ConfigSource.register({ resolve: async () => ({}) }),
  })
  await runtime.run(async () => {
    expect((await Bun.file(auth).json()).credentials).toEqual({ fixture: retained })
    expect(await Bun.file(config).text()).toBe(raw)
    const ledger = await Storage.read<Record<string, number>>(["meta", "migration", "log-config"])
    expect(ledger[credentialID]).toBeGreaterThan(0)
    expect(ledger[configID]).toBeUndefined()
  })
})
