import { expect, test } from "bun:test"
import { ConfigSource } from "../../src/config/source"
import type { Migration } from "../../src/migration/types"
import { MigrationRegistry } from "../../src/migration/registry"
import { Storage } from "../../src/storage/storage"
import { testRuntime } from "../support/runtime"
import { runtimeHome } from "../support/runtime-home"

for (const sourceFirst of [false, true]) {
  test(`exclusive configuration excludes file migrations after composition (${sourceFirst})`, async () => {
    await using home = await runtimeHome()
    const file: Migration = {
      id: "20261012-fixture-file-config",
      description: "File configuration fixture",
      configuration: "files",
      execution: "startup",
      async up() {
        await Storage.write(["fixture", "file-config"], { done: true })
      },
    }
    const data: Migration = {
      id: "20261012-fixture-data",
      description: "Non-configuration fixture",
      execution: "startup",
      async up() {
        await Storage.write(["fixture", "data"], { done: true })
      },
    }
    const tracking = { sourceDomain: "old-fixture", aliases: { "released-data": data.id } }
    const register = (exclusive: boolean) => {
      if (exclusive && sourceFirst) ConfigSource.register({ resolve: async () => ({}) })
      MigrationRegistry.register("mixed-fixture", [file, data], tracking)
      MigrationRegistry.register("file-fixture", [{ ...file, id: "20261012-only-file" }])
      if (exclusive && !sourceFirst) ConfigSource.register({ resolve: async () => ({}) })
    }
    {
      await using runtime = await testRuntime({ home: home.host.home, register: () => register(true) })
      await runtime.run(async () => {
        expect(await Storage.readMany([["fixture", "file-config"]])).toEqual([undefined])
        expect(await Storage.read<{ done: boolean }>(["fixture", "data"])).toEqual({ done: true })
        expect(
          MigrationRegistry.list()
            .get("mixed-fixture")
            ?.map((item) => item.id),
        ).toEqual([data.id])
        expect(MigrationRegistry.list().has("file-fixture")).toBe(false)
        expect(() => MigrationRegistry.excludeFileConfiguration()).toThrow("before opening")
        expect(MigrationRegistry.legacyTracking().find((item) => item.targetDomain === "mixed-fixture")).toEqual({
          ...tracking,
          targetDomain: "mixed-fixture",
        })
        const ledger = await Storage.read<Record<string, number>>(["meta", "migration", "log-mixed-fixture"])
        expect(ledger[file.id]).toBeUndefined()
        expect(ledger[data.id]).toBeGreaterThan(0)
      })
    }
    {
      await using local = await testRuntime({ home: home.host.home, register: () => register(false) })
      await local.run(async () => {
        expect(await Storage.read<{ done: boolean }>(["fixture", "file-config"])).toEqual({ done: true })
        expect(MigrationRegistry.list().has("file-fixture")).toBe(true)
        expect(
          (await Storage.read<Record<string, number>>(["meta", "migration", "log-mixed-fixture"]))[file.id],
        ).toBeGreaterThan(0)
      })
    }
  })
}
