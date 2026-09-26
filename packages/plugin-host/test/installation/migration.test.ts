import { expect, test } from "bun:test"
import path from "node:path"
import { runMigrations } from "@ericsanchezok/synergy-harness/migration"
import { migrationFixture } from "@ericsanchezok/synergy-harness/test/migration/fixture"
import { registerInstallationMigrations } from "../../src/installation/migration"
import { initializeInstallationSelection } from "../../src/installation/selection"

test.each([false, true])(
  "the central migration preserves the initial selection on replay (legacy=%s)",
  async (legacy) => {
    await using runtime = await migrationFixture({ register: registerInstallationMigrations })
    await runtime.run(async () => {
      if (legacy) await Bun.write(path.join(runtime.host.root, "config/synergy.d/100-general.jsonc"), "{}")
      const first = await runMigrations({ targetDomain: "installation", output: "silent" })
      expect(first.completed).toBe(1)
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
