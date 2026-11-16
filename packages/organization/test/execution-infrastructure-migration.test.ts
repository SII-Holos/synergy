import { expect, test } from "bun:test"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationExecutionProtocol as Execution } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationRecord as Record } from "../src/storage/records"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { OrganizationSessionResources as Resources } from "../src/session-resources"
import { executionFixture } from "./support/execution"

test("legacy selections acquire explicit native facets without changing accepted grants or stored evidence", async () => {
  await using f = await executionFixture({ endpoint: "https://provider.example/v1" })
  const legacy = await f.run(async () => {
    const { infrastructure: _, ...selection } = f.grant.selection
    const contract = (await Record.read(Record.SessionResources, Keys.sessionResources(f.sessionID)))!
    const previous = { ...contract, schemaVersion: 1, selection }
    const grant = { ...f.grant, schemaVersion: 4, selection }
    await Storage.transaction(async () => {
      await Storage.write(Keys.sessionResources(f.sessionID), previous)
      await Storage.write(Keys.executionGrant(f.grant.grantID), grant)
    })
    return { contract: previous, grant }
  })
  await f.restart()
  await f.run(async () => {
    expect(await Resources.get(f.credentials.alice, f.sessionID)).toMatchObject({
      revision: f.grant.selectionRevision,
      selection: f.grant.selection,
    })
    expect(await Record.read(Record.ExecutionGrant, Keys.executionGrant(f.grant.grantID))).toEqual(f.grant)
    expect(await Storage.read(Keys.sessionResources(f.sessionID))).toEqual(legacy.contract)
    expect(await Storage.read(Keys.executionGrant(f.grant.grantID))).toEqual(legacy.grant)
    expect(Execution.LegacyGrant4.safeParse(f.grant).success).toBeFalse()
    expect((await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!.retainedExecutionGrants).toBe(1)
  })
  await f.restart()
  await f.run(async () => {
    expect(await Record.read(Record.ExecutionGrant, Keys.executionGrant(f.grant.grantID))).toEqual(f.grant)
    expect((await Record.read(Record.SessionResources, Keys.sessionResources(f.sessionID)))!.schemaVersion).toBe(2)
    await Storage.write(Keys.sessionResources(f.sessionID), { ...legacy.contract, selection: f.grant.selection })
    await expect(Resources.get(f.credentials.alice, f.sessionID)).rejects.toThrow()
  })
})
