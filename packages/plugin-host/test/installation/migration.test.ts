import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { runMigrations } from "@ericsanchezok/synergy-harness/migration"
import { migrationFixture } from "@ericsanchezok/synergy-harness/test/migration/fixture"
import { registerInstallationMigrations } from "../../src/installation/migration"
import { initializeInstallationSelection, upgradeInstallationSelection } from "../../src/installation/selection"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"

test.each([false, true])(
  "the central migration preserves the initial selection on replay (legacy=%s)",
  async (legacy) => {
    await using runtime = await migrationFixture({ register: registerInstallationMigrations })
    await runtime.run(async () => {
      if (legacy) await Bun.write(path.join(runtime.host.root, "config/synergy.d/100-general.jsonc"), "{}")
      const first = await runMigrations({ targetDomain: "installation", output: "silent" })
      expect(first.completed).toBe(3)
      const file = path.join(runtime.host.root, "installations/selection-v1.json")
      const selection = await Bun.file(file).json()
      expect(selection).toEqual({ version: 1, roots: legacy ? ["@ericsanchezok/synergy-web"] : [] })
      await Bun.write(path.join(runtime.host.root, "data/new-record"), "later activity")
      await runMigrations({ targetDomain: "installation", output: "silent" })
      expect(await initializeInstallationSelection(runtime.host.root)).toEqual(selection.roots)
      expect(await Bun.file(file).json()).toEqual(selection)
    })
  },
)

test("selection v2 expands legacy roots after the original migration receipt without changing the v1 evidence", async () => {
  await using runtime = await migrationFixture({ register: registerInstallationMigrations })
  await runtime.run(async () => {
    const legacy = {
      version: 1,
      roots: ["@ericsanchezok/synergy-workflows", "@ericsanchezok/synergy-connections", "third-party"],
    }
    const file = path.join(runtime.host.root, "installations/selection-v1.json")
    await Bun.write(file, JSON.stringify(legacy))
    await Storage.write(["meta", "migration", "log-installation"], { "20260926-installation-selection-v1": 42 })
    await runMigrations({ targetDomain: "installation", output: "silent" })
    const selected = await Bun.file(path.join(runtime.host.root, "installations/selection-v2.json")).json()
    expect(selected.version).toBe(2)
    expect(selected.roots).toContain("third-party")
    expect(selected.roots).toContain("@ericsanchezok/synergy-blueprint")
    expect(selected.roots).toContain("@ericsanchezok/synergy-boss-feishu")
    expect(selected.roots).not.toContain("@ericsanchezok/synergy-workflows")
    expect(selected.roots).not.toContain("@ericsanchezok/synergy-connections")
    await runMigrations({ targetDomain: "installation", output: "silent" })
    expect(await Bun.file(path.join(runtime.host.root, "installations/selection-v2.json")).json()).toEqual(selected)
    expect(await Bun.file(file).json()).toEqual(legacy)
  })
})

test("interrupted selection metadata upgrade preserves its source and retries idempotently", async () => {
  await using runtime = await migrationFixture()
  const root = runtime.host.root
  const legacy = { version: 1, roots: ["@ericsanchezok/synergy-connections", "third-party"] }
  const original = path.join(root, "installations/selection-v1.json")
  const target = path.join(root, "installations/selection-v2.json")
  await Bun.write(original, JSON.stringify(legacy))
  await fs.mkdir(target)
  await expect(upgradeInstallationSelection(root)).rejects.toThrow()
  expect(await Bun.file(original).json()).toEqual(legacy)
  await fs.rmdir(target)
  const selected = await upgradeInstallationSelection(root)
  expect(selected).toContain("@ericsanchezok/synergy-blueprint")
  expect(selected).toContain("@ericsanchezok/synergy-channel-feishu")
  expect(selected).toContain("third-party")
  expect(await upgradeInstallationSelection(root)).toEqual(selected)
})

test("selection retirement catches already migrated homes without rewriting evidence or unrelated roots", async () => {
  await using runtime = await migrationFixture({ register: registerInstallationMigrations })
  const root = runtime.host.root
  const original = path.join(root, "installations/selection-v2.json")
  const legacy = {
    version: 2,
    roots: [
      "@ericsanchezok/synergy-holos",
      "@ericsanchezok/synergy-channel-clarus",
      "@ericsanchezok/synergy-web",
      "third-party",
    ],
  }
  await Bun.write(original, JSON.stringify(legacy))
  await runtime.run(async () => {
    await Storage.write(["meta", "migration", "log-installation"], {
      "20260926-installation-selection-v1": 42,
      "20261012-installation-selection-v2": 43,
    })
    await runMigrations({ targetDomain: "installation", output: "silent" })
    expect(await upgradeInstallationSelection(root)).toEqual(["@ericsanchezok/synergy-web", "third-party"])
    const upgraded = await Bun.file(path.join(root, "installations/selection-v3.json")).json()
    expect(upgraded).toEqual({ version: 3, roots: ["@ericsanchezok/synergy-web", "third-party"] })
    expect(await Bun.file(original).json()).toEqual(legacy)
    expect(await upgradeInstallationSelection(root)).toEqual(upgraded.roots)
  })
})
