import { expect, test } from "bun:test"
import { migrationFixture } from "@ericsanchezok/synergy-harness/test/migration/fixture"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { runMigrations } from "@ericsanchezok/synergy-harness/migration"
import { registerBlueprintMigrations } from "../../src/blueprint/migration"

const id = "20261012-blueprint-home-scope"

test("Blueprint owner catches up retained loop scopes after the shared migration completed", async () => {
  await using fixture = await migrationFixture({ register: registerBlueprintMigrations })
  await fixture.run(async () => {
    await Storage.write(
      ["meta", "migration", "log-blueprint_loop"],
      Object.fromEntries(
        [
          "20260624-blueprint-cancel-stale-armed-loops",
          "20260628-blueprint-loop-audit-agent",
          "20260703-blueprint-single-active-loop",
          "20260704-blueprint-loop-user-prompt",
          "20260708-blueprint-loop-source",
          "20260920-blueprint-loop-retired-waiting-status",
          "20260715-blueprint-loop-source-plugin",
          "20261002-blueprint-primary-agent-identities",
        ].map((id) => [id, 42]),
      ),
    )
    const loop = { id: "blp_retained", scopeID: "global", futureOwner: { scopeID: "global" } }
    await Storage.write(["blueprint_loops", "global", loop.id], loop)
    await runMigrations({ targetDomain: "blueprint_loop", output: "silent" })
    expect(await Storage.read<Record<string, unknown>>(["blueprint_loops", "home", loop.id])).toEqual({
      ...loop,
      scopeID: "home",
    })
    expect(
      (await Storage.read<Record<string, number>>(["meta", "migration", "log-blueprint_loop"]))[id],
    ).toBeGreaterThan(0)
    await runMigrations({ targetDomain: "blueprint_loop", output: "silent" })
    expect(await Storage.scan(["blueprint_loops", "home"])).toEqual([loop.id])
  })
})
