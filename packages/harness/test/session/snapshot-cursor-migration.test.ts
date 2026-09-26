import { expect, test } from "bun:test"
import { migrations } from "../../src/session/migration"
import { MigrationRegistry } from "../../src/migration/registry"
import { runMigrations } from "../../src/migration"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { Identifier } from "../../src/id/id"
import { migrationFixture } from "../migration/fixture"

for (const existing of [false, true]) {
  test(`operation summary cursor migration supports ${existing ? "upgrade" : "fresh installation"}`, async () => {
    const migration = migrations.find((item) => item.id === "20260923-session-operation-snapshot-cursor")
    expect(migration).toBeDefined()
    await using runtime = await migrationFixture({
      register() {
        MigrationRegistry.register("cursor-test", [migration!])
      },
    })
    await runtime.run(async () => {
      const scopeID = Identifier.asScopeID("home"),
        sessionID = Identifier.ascending("session")
      const info = {
        id: sessionID,
        scope: { id: scopeID, type: "home" },
        time: { created: 1, updated: 2, archived: 3 },
        retained: { unknown: true },
      }
      const key = StoragePath.sessionSummaryCursor(scopeID, sessionID)
      const cursor = {
        version: 2,
        ranges: [{ legacyRoot: "/legacy", from: "before", to: "after", files: ["a.txt"] }],
        retained: { unknown: true },
      }
      if (existing) {
        await Storage.write(StoragePath.sessionInfo(scopeID, sessionID), info)
        await Storage.write(key, cursor)
      }
      await runMigrations({ targetDomain: "cursor-test", output: "silent" })
      if (existing) {
        expect(await Storage.read<unknown>(key)).toEqual({ ...cursor, version: 3 })
        expect(await Storage.read<unknown>(StoragePath.sessionInfo(scopeID, sessionID))).toEqual(info)
        await migration!.upSession!({ scopeID, sessionID }, () => {})
        expect(await Storage.read<unknown>(key)).toEqual({ ...cursor, version: 3 })
      } else expect(await Storage.list(["sessions"])).toEqual([])
    })
  })
}
