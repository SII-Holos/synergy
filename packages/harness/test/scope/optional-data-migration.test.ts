import { expect, test } from "bun:test"
import { migrationFixture } from "../migration/fixture"
import { migrations } from "../../src/scope/migration"
import { Storage } from "../../src/storage/storage"

test("historical Scope migration leaves unavailable owners' records untouched", async () => {
  await using fixture = await migrationFixture()
  await fixture.run(async () => {
    const records = [
      ["notes", "global", "nte_retained"],
      ["notes", "orphan", "nte_retained"],
      ["agenda", "items", "global", "agn_retained"],
      ["agenda", "runs", "global", "run_retained"],
      ["agenda", "items", "orphan", "agn_retained"],
      ["blueprint_loops", "global", "blp_retained"],
    ]
    const retained = { scopeID: "global", futureOwner: { id: "global", category: "global" } }
    for (const key of records) await Storage.write(key, retained)
    await Storage.write(["sessions", "global", "ses_retained", "info"], {
      scope: { id: "global", type: "global" },
      futureOwner: retained,
    })
    for (const id of ["20260424-scope-reclaim-orphans", "20260624-scope-global-to-home"])
      await migrations.find((migration) => migration.id === id)!.up(() => {})
    for (const key of records) expect(await Storage.read<Record<string, unknown>>(key)).toEqual(retained)
    expect(
      (await Storage.read<Record<string, unknown>>(["sessions", "home", "ses_retained", "info"])).futureOwner,
    ).toEqual(retained)
  })
})
