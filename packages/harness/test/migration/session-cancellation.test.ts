import { expect, test } from "bun:test"
import { Storage } from "../../src/storage/storage"
import { SessionMigrationTarget } from "../../src/migration/session-target"
import { UpgradeWork } from "../../src/storage/upgrade-work"

test("owner schema walks stop between records when preparation is cancelled", async () => {
  const scopeID = "cancellation-fixture",
    sessionID = "owner"
  for (const id of ["a", "b", "c"])
    await Storage.write(["sessions", scopeID, sessionID, "messages", id, "info"], { id })
  const controller = new AbortController()
  let seen = 0
  try {
    await expect(
      UpgradeWork.run({ background: true, signal: controller.signal }, () =>
        SessionMigrationTarget.provide({ scopeID, sessionID }, async () => {
          for await (const _ of SessionMigrationTarget.records({ kind: "message" })) {
            seen++
            controller.abort(new DOMException("pause migration", "AbortError"))
          }
        }),
      ),
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(seen).toBe(1)
  } finally {
    await Storage.removeTree(["sessions", scopeID])
  }
})
