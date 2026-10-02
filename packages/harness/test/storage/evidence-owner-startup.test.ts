import { expect, spyOn, test } from "bun:test"
import { migrationFixture } from "../migration/fixture"
import { MigrationRegistry } from "../../src/migration/registry"
import { runMigrations } from "../../src/migration"
import { migrations } from "../../src/storage/migration"
import { EvidenceOwnerProjection } from "../../src/storage/evidence-owner-projection"
import { Storage } from "../../src/storage/storage"
import { StorageBusyError } from "../../src/storage/errors"

test("evidence structure admission does not depend on historical maintenance availability", async () => {
  const migration = migrations.find((entry) => entry.id === EvidenceOwnerProjection.id)!
  await using runtime = await migrationFixture({
    register: () => MigrationRegistry.register("storage", [migration]),
  })
  await runtime.run(async () => {
    using prepare = spyOn(Storage.current().store, "prepareEvidenceOwners").mockRejectedValue(
      new StorageBusyError("Historical maintenance admission expired"),
    )
    await runMigrations({ output: "silent" })
    expect(prepare).not.toHaveBeenCalled()
    await Storage.write(["notes", "new-work"], { text: "admitted" })
    expect(await Storage.read<{ text: string }>(["notes", "new-work"])).toEqual({ text: "admitted" })
    expect(await Storage.current().store.evidenceOwners()).toEqual([])
  })
})
