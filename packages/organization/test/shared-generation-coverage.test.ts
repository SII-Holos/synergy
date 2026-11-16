import { expect, test } from "bun:test"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { keyBytes } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { OrganizationSyncProtocol as Sync } from "@ericsanchezok/synergy-organization-protocol"
import { digest } from "../src/auth/secret"
import { OrganizationSessionDirectory as Directory } from "../src/session-directory"
import { OrganizationSharing as Sharing } from "../src/sharing"
import { OrganizationSharedGeneration as Generations } from "../src/shared-generation"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { sharedProducerFixture } from "./support/shared-producer"

for (const hidden of ["directory-branch", "generation-branch", "canonical-leaf"] as const)
  test(`retained inventory refuses a ${hidden} hidden from the canonical tree before publishing its format`, async () => {
    await using f = await sharedProducerFixture()
    const sessionID = "coverage-original-session"
    await f.run(() =>
      Directory.reservePrivate(f.credentials.alice, { sessionID, projectID: "project", runtimeID: "runtime-alice" }),
    )
    await f.run(() => Sharing.share(f.credentials.alice, sessionID, { expectedShareGeneration: 0 }))
    const session = await f.run(() => Directory.get(f.credentials.alice, sessionID))
    const events: Sync.Event[] = [
      {
        type: "session",
        sequence: 1,
        session: {
          sessionID,
          projectID: session.projectID,
          creatorID: session.creatorID,
          driverRuntimeID: session.driverRuntimeID,
          bindingEpoch: session.bindingEpoch,
          createdAt: session.createdAt,
          shareGeneration: 1,
        },
      },
    ]
    const ack = await f.run(() =>
      f.sync({
        schemaVersion: 1,
        sessionID,
        projectID: session.projectID,
        bindingEpoch: session.bindingEpoch,
        shareGeneration: 1,
        firstSeq: 1,
        lastSeq: 1,
        events,
        payloadHash: digest(JSON.stringify({ firstSeq: 1, lastSeq: 1, events })),
      }),
    )
    expect(ack.nextSeq).toBe(2)
    expect(await f.run(() => Generations.initialized())).toBe(false)
    const address =
      hidden === "directory-branch"
        ? Keys.sessions()
        : hidden === "generation-branch"
          ? Keys.sharedEvent(sessionID, 1, 1).slice(0, 4)
          : Keys.sharedEvent(sessionID, 1, 1)
    const rollback = new Error("Rollback only the original node corruption")
    let nodeBefore = 0,
      nodeAfter = 0,
      originalStillPresent = false,
      published = false
    const observed: { result?: { status: "fulfilled" } | { status: "rejected"; error: unknown } } = {}
    const rolled = await f.run(() =>
      Storage.transaction(async (tx) => {
        const values = [tx.namespace, keyBytes(address)]
        nodeBefore = (await tx.raw.query("SELECT key_id FROM storage_nodes WHERE namespace = ? AND key_id = ?", values))
          .length
        await tx.raw.query("DELETE FROM storage_nodes WHERE namespace = ? AND key_id = ?", values)
        nodeAfter = (await tx.raw.query("SELECT key_id FROM storage_nodes WHERE namespace = ? AND key_id = ?", values))
          .length
        originalStillPresent = (await tx.readMany([Keys.sharedEvent(sessionID, 1, 1)]))[0] !== undefined
        observed.result = await Generations.upgrade(
          () => {},
          () => {},
        ).then(
          () => ({ status: "fulfilled" as const }),
          (error: unknown) => ({ status: "rejected" as const, error }),
        )
        published = await Generations.initialized()
        throw rollback
      }).then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      ),
    )
    expect(rolled).toEqual({ status: "rejected", error: rollback })
    expect(nodeBefore).toBe(1)
    expect(nodeAfter).toBe(0)
    expect(originalStillPresent).toBe(true)
    expect(observed.result?.status).toBe("rejected")
    expect(published).toBe(false)
    expect(await f.run(() => Generations.initialized())).toBe(false)
    await f.run(() => Generations.assertCoverage(() => {}))
    expect((await f.run(() => Sharing.snapshot(f.credentials.bob, sessionID, { limit: 100 }))).watermark).toBe(1)
  })
