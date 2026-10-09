import { expect, test } from "bun:test"
import { Config } from "../../src/config/config"
import { ConfigSource } from "../../src/config/source"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { testRuntime } from "../support/runtime"
import { MigrationRegistry } from "../../src/migration/registry"
import { Storage } from "../../src/storage/storage"
import { registerConfigMigrations } from "../../src/config/migration"
import { RuntimeContext } from "../../src/lifecycle/context"
import { runtimeHome } from "../support/runtime-home"

function read<T>(runtime: Awaited<ReturnType<typeof testRuntime>>, fn: () => Promise<T>) {
  return runtime.run(() => ScopeContext.provide({ scope: Scope.home(), fn }))
}

test("exclusive host configuration is isolated, schema-validated, sealed and has no file sources", async () => {
  const snapshot = { model: "fixture/approved", default_agent: "fixture" }
  await using first = await testRuntime({
    env: { SYNERGY_CONFIG_CONTENT: '{"model":"foreign/unapproved"}' },
    register: () => ConfigSource.register({ resolve: async () => snapshot }),
  })
  await using second = await testRuntime({
    register: () => ConfigSource.register({ resolve: async () => ({ model: "second/approved" }) }),
  })
  expect((await read(first, Config.current)).model).toBe("fixture/approved")
  expect((await read(first, Config.global)).model).toBe("fixture/approved")
  expect((await read(second, Config.current)).model).toBe("second/approved")
  expect(await read(first, Config.directories)).toEqual([])
  await expect(read(first, () => Config.updateGlobal({ model: "foreign/unapproved" }))).rejects.toThrow("read-only")
  expect((await read(first, () => Config.domainGet("models"))).model).toBe("fixture/approved")
  await read(first, async () =>
    expect(() => ConfigSource.register({ resolve: async () => ({}) })).toThrow("before opening"),
  )
})

test("a host configuration failure cannot reuse a last-good or file fallback", async () => {
  let failing = false
  await using runtime = await testRuntime({
    register: () =>
      ConfigSource.register({
        resolve: async () => {
          if (failing) throw new Error("host unavailable")
          return { model: "fixture/approved" }
        },
      }),
  })
  expect((await read(runtime, Config.current)).model).toBe("fixture/approved")
  failing = true
  await expect(read(runtime, Config.resolveExecution)).rejects.toThrow("host unavailable")
  await expect(read(runtime, Config.global)).rejects.toThrow("host unavailable")
  await read(runtime, () => Config.state.resetAll())
  await expect(read(runtime, Config.current)).rejects.toThrow("host unavailable")
})

test("an invalid exclusive snapshot prevents Runtime activation", async () => {
  await expect(
    testRuntime({ register: () => ConfigSource.register({ resolve: async () => ({ execution: "invalid" }) }) }),
  ).rejects.toThrow()
})

test("exclusive configuration migrates credentials without stamping local file upgrades", async () => {
  await using runtime = await testRuntime({
    register: () => ConfigSource.register({ resolve: async () => ({ model: "fixture/approved" }) }),
  })
  await runtime.run(async () => {
    expect(
      MigrationRegistry.list()
        .get("config")
        ?.map((item) => item.id),
    ).toEqual(["20260625-provider-auth-v2"])
    const [log] = await Storage.readMany<Record<string, number>>([["meta", "migration", "log-config"]])
    expect(Object.keys(log ?? {})).toEqual(["20260625-provider-auth-v2"])
    // Storage and Session upgrades still run; configuration authority does not
    // exempt historical data from its migrations.
    expect(MigrationRegistry.list().has("session")).toBe(true)
  })
})

test("configuration ownership is independent of registration order and Runtime", async () => {
  await using fixture = await runtimeHome()
  for (const sourceFirst of [false, true]) {
    const instance = RuntimeContext.create(fixture.host)
    try {
      instance.run(() => {
        if (!sourceFirst) registerConfigMigrations()
        ConfigSource.register({ resolve: async () => ({}) })
        registerConfigMigrations()
        expect(
          MigrationRegistry.list()
            .get("config")
            ?.map((item) => item.id),
        ).toEqual(["20260625-provider-auth-v2"])
      })
    } finally {
      instance.dispose()
    }
  }
  await using local = await testRuntime()
  await local.run(async () => {
    expect(MigrationRegistry.list().has("config")).toBe(true)
    expect((await Storage.readMany([["meta", "migration", "log-config"]]))[0]).toBeDefined()
  })
})
