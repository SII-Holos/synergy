import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Identifier } from "../../src/id/id"
import { Scope } from "../../src/scope"
import { migrations } from "../../src/blueprint/migration"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"

describe("blueprint migrations", () => {
  test("migrates legacy supervisor audit fields to audit agent fields", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope
    const scopeID = Identifier.asScopeID(scope.id)
    const loopID = Identifier.ascending("blueprint_loop")
    const now = Date.now()

    await Storage.write(StoragePath.blueprintLoop(scopeID, loopID), {
      id: loopID,
      noteID: "note_test",
      title: "Legacy Loop",
      sessionID: "ses_execution",
      supervisorSessionID: "ses_supervisor",
      scopeID: scopeID as string,
      status: "auditing",
      time: { created: now, updated: now },
    })

    const migration = migrations.find((entry) => entry.id === "20260628-blueprint-loop-audit-agent")
    expect(migration).toBeDefined()
    await migration!.up(() => {})

    const migrated = await Storage.read<Record<string, unknown>>(StoragePath.blueprintLoop(scopeID, loopID))
    expect(migrated.auditAgent).toBe("supervisor")
    expect(migrated.auditSessionID).toBe("ses_supervisor")
    expect("supervisorSessionID" in migrated).toBe(false)
  })

  test("preserves explicit audit session while dropping legacy supervisor session", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope
    const scopeID = Identifier.asScopeID(scope.id)
    const loopID = Identifier.ascending("blueprint_loop")
    const now = Date.now()

    await Storage.write(StoragePath.blueprintLoop(scopeID, loopID), {
      id: loopID,
      noteID: "note_test",
      title: "Partial New Loop",
      sessionID: "ses_execution",
      auditAgent: "security-reviewer",
      auditSessionID: "ses_audit",
      supervisorSessionID: "ses_legacy",
      scopeID: scopeID as string,
      status: "auditing",
      time: { created: now, updated: now },
    })

    const migration = migrations.find((entry) => entry.id === "20260628-blueprint-loop-audit-agent")
    expect(migration).toBeDefined()
    await migration!.up(() => {})

    const migrated = await Storage.read<Record<string, unknown>>(StoragePath.blueprintLoop(scopeID, loopID))
    expect(migrated.auditAgent).toBe("security-reviewer")
    expect(migrated.auditSessionID).toBe("ses_audit")
    expect("supervisorSessionID" in migrated).toBe(false)
  })
})
