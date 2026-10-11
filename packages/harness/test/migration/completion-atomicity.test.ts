import { expect, spyOn, test } from "bun:test"
import { migrationFixture } from "./fixture"
import { MigrationRegistry } from "../../src/migration/registry"
import { runMigrations, getMigrationStatus } from "../../src/migration"
import { Storage } from "../../src/storage/storage"

test("a failed cohort retirement cannot commit the migration completion marker", async () => {
  await using fixture = await migrationFixture()
  await fixture.run(async () => {
    const domain = "test-completion-atomicity"
    const id = "resident-complete"
    const cohort = ["compat_import", "cohorts", domain, id]
    const retained = { domain, id, residentComplete: true }
    await Storage.write(cohort, retained)
    let attempts = 0
    MigrationRegistry.register(domain, [
      {
        id,
        description: "Complete resident migration",
        async up() {
          attempts++
        },
      },
    ])
    const remove = Storage.remove
    const fault = spyOn(Storage, "remove").mockImplementation(async (key) => {
      if (JSON.stringify(key) === JSON.stringify(cohort)) throw new Error("cohort retirement unavailable")
      await remove(key)
    })
    try {
      await expect(runMigrations({ targetDomain: domain, output: "silent" })).rejects.toThrow(
        "cohort retirement unavailable",
      )
    } finally {
      fault.mockRestore()
    }
    expect(await Storage.read<typeof retained>(cohort)).toEqual(retained)
    expect((await getMigrationStatus(domain))[domain].pending.map((migration) => migration.id)).toEqual([id])
    expect((await runMigrations({ targetDomain: domain, output: "silent" })).completed).toBe(1)
    expect(attempts).toBe(2)
    expect((await Storage.readMany([cohort]))[0]).toBeUndefined()
    expect((await getMigrationStatus(domain))[domain].pending).toEqual([])
  })
})
