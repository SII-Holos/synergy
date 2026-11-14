import { expect, test } from "bun:test"
import {
  OrganizationCommandProtocol as Command,
  OrganizationExecutionProtocol as Execution,
} from "@ericsanchezok/synergy-organization-protocol"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { executionFixture } from "./support/execution"
import { OrganizationExecutionIndex as Index } from "../src/execution-index"
import { OrganizationRecord as Record } from "../src/storage/records"
import { OrganizationStoragePath as Keys } from "../src/storage/path"

test("retained grant pages rebuild from canonical accepted work without a local lease list", async () => {
  await using f = await executionFixture({ endpoint: "https://provider.example/v1" })
  await f.run(async () => {
    for (let i = 0; i < 33; i++) {
      const request = f.request("queued-" + i)
      request.input.mode = "task"
      const admitted = await f.commands.input(f.credentials.alice, request)
      if (admitted.kind !== "admitted") throw new Error("Expected a new admitted task")
      const permit = admitted.delivery.authorization.permit
      await f.commands.observe(
        f.connections.capture(permit.runtimeID),
        Command.InputResult.parse({
          attempt: {
            schemaVersion: 1,
            permit,
            receivedAt: Date.now(),
            status: "accepted",
            acceptedAttemptID: permit.attemptID,
          },
          accepted: {
            schemaVersion: 1,
            permit,
            acceptedAt: Date.now(),
            intakeSeq: i + 2,
            effect: { kind: "inbox", mode: "task", itemID: "inb_" + i, messageID: "msg_" + i },
          },
        }),
      )
    }
    await Storage.removeTree(["organization", "retained-execution-grants"])
    await Storage.write(
      Keys.executionGrant(f.grant.grantID),
      Execution.LegacyGrant3.parse({
        ...f.grant,
        schemaVersion: 3,
        selection: {
          modelResourceID: f.grant.selection.modelResourceID,
          connectionResourceIDs: f.grant.selection.connectionResourceIDs,
        },
      }),
    )
    await Index.migration.up(() => {})
    const session = (await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!
    const found: string[] = []
    let after: string | undefined
    for (;;) {
      const page = await Index.page(session, { after, limit: 7 })
      found.push(...page.map((entry) => entry.grantID))
      if (page.length < 7) break
      after = page.at(-1)!.grantID
    }
    expect(found).toHaveLength(34)
    expect(new Set(found).size).toBe(34)
    expect(found).toContain(f.grant.grantID)
    const missing = [
      "organization",
      "retained-execution-grants",
      session.sessionID,
      String(session.bindingEpoch),
      f.grant.grantID,
    ]
    await Storage.remove(missing)
    await expect(Index.page(session, { limit: 7 })).rejects.toMatchObject({ data: { code: "SERVICE_UNAVAILABLE" } })
  })
})

test("real grant admission updates its derived retained index in the same transaction", async () => {
  await using f = await executionFixture({ endpoint: "https://provider.example/v1" })
  await f.run(async () => {
    await Index.migration.up(() => {})
    const request = f.request("later-provisional")
    request.input.mode = "task"
    const admitted = await f.commands.input(f.credentials.alice, request)
    if (admitted.kind !== "admitted") throw new Error("Expected admitted task")
    const session = (await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!
    expect((await Index.page(session, { limit: 7 })).map((entry) => entry.grantID)).toContain(
      admitted.delivery.authorization.permit.provisionalGrantID!,
    )
  })
})
