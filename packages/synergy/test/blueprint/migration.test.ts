import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Identifier } from "../../src/id/id"
import { Scope } from "../../src/scope"
import { migrations } from "../../src/blueprint/migration"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"

function blueprintLoop(input: {
  id: string
  noteID: string
  sessionID: string
  scopeID: string
  status: "running" | "waiting" | "auditing" | "armed" | "completed" | "failed" | "cancelled"
  updated: number
}) {
  return {
    id: input.id,
    noteID: input.noteID,
    title: `Loop ${input.id}`,
    sessionID: input.sessionID,
    auditAgent: "supervisor",
    scopeID: input.scopeID,
    status: input.status,
    time: { created: input.updated - 100, updated: input.updated },
  }
}

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

  test("collapses duplicate active BlueprintLoops and clears cancelled session bindings", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope
    const scopeID = Identifier.asScopeID(scope.id)
    const noteID = Identifier.ascending("note")
    const keepLoopID = Identifier.ascending("blueprint_loop")
    const cancelLoopID = Identifier.ascending("blueprint_loop")
    const keepSessionID = Identifier.ascending("session")
    const cancelSessionID = Identifier.ascending("session")
    const now = Date.now()

    await Storage.write(StoragePath.note(scopeID, noteID), {
      id: noteID,
      title: "Blueprint",
      kind: "blueprint",
      blueprint: { activeLoopID: keepLoopID },
      time: { created: now, updated: now },
    })
    await Storage.write(
      StoragePath.blueprintLoop(scopeID, keepLoopID),
      blueprintLoop({
        id: keepLoopID,
        noteID,
        sessionID: keepSessionID,
        scopeID,
        status: "running",
        updated: now,
      }),
    )
    await Storage.write(
      StoragePath.blueprintLoop(scopeID, cancelLoopID),
      blueprintLoop({
        id: cancelLoopID,
        noteID,
        sessionID: cancelSessionID,
        scopeID,
        status: "waiting",
        updated: now + 1000,
      }),
    )
    await Storage.write(StoragePath.sessionInfo(scopeID, Identifier.asSessionID(cancelSessionID)), {
      id: cancelSessionID,
      scope: { id: scopeID, directory: scope.directory, worktree: scope.worktree },
      blueprint: { loopID: cancelLoopID, loopRole: "execution" },
    })

    const migration = migrations.find((entry) => entry.id === "20260703-blueprint-single-active-loop")
    expect(migration).toBeDefined()
    await migration!.up(() => {})

    const kept = await Storage.read<Record<string, unknown>>(StoragePath.blueprintLoop(scopeID, keepLoopID))
    const cancelled = await Storage.read<Record<string, unknown>>(StoragePath.blueprintLoop(scopeID, cancelLoopID))
    const note = await Storage.read<Record<string, unknown>>(StoragePath.note(scopeID, noteID))
    const cancelledSession = await Storage.read<Record<string, unknown>>(
      StoragePath.sessionInfo(scopeID, Identifier.asSessionID(cancelSessionID)),
    )

    expect(kept.status).toBe("running")
    expect(cancelled.status).toBe("cancelled")
    expect(cancelled.time).toMatchObject({ completed: expect.any(Number) })
    expect((note.blueprint as { activeLoopID?: string }).activeLoopID).toBe(keepLoopID)
    expect(cancelledSession.blueprint).toBeUndefined()
  })

  test("keeps the newest active BlueprintLoop when the note does not identify one", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope
    const scopeID = Identifier.asScopeID(scope.id)
    const noteID = Identifier.ascending("note")
    const olderLoopID = Identifier.ascending("blueprint_loop")
    const newerLoopID = Identifier.ascending("blueprint_loop")
    const now = Date.now()

    await Storage.write(StoragePath.note(scopeID, noteID), {
      id: noteID,
      title: "Blueprint",
      kind: "blueprint",
      blueprint: {},
      time: { created: now, updated: now },
    })
    await Storage.write(
      StoragePath.blueprintLoop(scopeID, olderLoopID),
      blueprintLoop({
        id: olderLoopID,
        noteID,
        sessionID: Identifier.ascending("session"),
        scopeID,
        status: "running",
        updated: now,
      }),
    )
    await Storage.write(
      StoragePath.blueprintLoop(scopeID, newerLoopID),
      blueprintLoop({
        id: newerLoopID,
        noteID,
        sessionID: Identifier.ascending("session"),
        scopeID,
        status: "auditing",
        updated: now + 1000,
      }),
    )

    const migration = migrations.find((entry) => entry.id === "20260703-blueprint-single-active-loop")
    expect(migration).toBeDefined()
    await migration!.up(() => {})

    const older = await Storage.read<Record<string, unknown>>(StoragePath.blueprintLoop(scopeID, olderLoopID))
    const newer = await Storage.read<Record<string, unknown>>(StoragePath.blueprintLoop(scopeID, newerLoopID))
    const note = await Storage.read<Record<string, unknown>>(StoragePath.note(scopeID, noteID))

    expect(older.status).toBe("cancelled")
    expect(newer.status).toBe("auditing")
    expect((note.blueprint as { activeLoopID?: string }).activeLoopID).toBe(newerLoopID)
  })

  test("backfills BlueprintLoop userPrompt from start message metadata", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope
    const scopeID = Identifier.asScopeID(scope.id)
    const loopID = Identifier.ascending("blueprint_loop")
    const sessionID = Identifier.ascending("session")
    const messageID = Identifier.ascending("message")
    const now = Date.now()

    await Storage.write(
      StoragePath.blueprintLoop(scopeID, loopID),
      blueprintLoop({
        id: loopID,
        noteID: Identifier.ascending("note"),
        sessionID,
        scopeID,
        status: "running",
        updated: now,
      }),
    )
    await Storage.write(StoragePath.messageInfo(scopeID, Identifier.asSessionID(sessionID), messageID), {
      id: messageID,
      sessionID,
      role: "user",
      metadata: {
        source: "blueprint_loop_start",
        loopID,
        userPrompt: "  Critical constraint  ",
      },
    })

    const migration = migrations.find((entry) => entry.id === "20260704-blueprint-loop-user-prompt")
    expect(migration).toBeDefined()
    await migration!.up(() => {})

    const migrated = await Storage.read<Record<string, unknown>>(StoragePath.blueprintLoop(scopeID, loopID))
    expect(migrated.userPrompt).toBe("Critical constraint")
  })

  test("leaves BlueprintLoop userPrompt unchanged when start metadata is blank", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope
    const scopeID = Identifier.asScopeID(scope.id)
    const loopID = Identifier.ascending("blueprint_loop")
    const sessionID = Identifier.ascending("session")
    const messageID = Identifier.ascending("message")
    const now = Date.now()

    await Storage.write(
      StoragePath.blueprintLoop(scopeID, loopID),
      blueprintLoop({
        id: loopID,
        noteID: Identifier.ascending("note"),
        sessionID,
        scopeID,
        status: "running",
        updated: now,
      }),
    )
    await Storage.write(StoragePath.messageInfo(scopeID, Identifier.asSessionID(sessionID), messageID), {
      id: messageID,
      sessionID,
      role: "user",
      metadata: {
        source: "blueprint_loop_start",
        loopID,
        userPrompt: "  ",
      },
    })

    const migration = migrations.find((entry) => entry.id === "20260704-blueprint-loop-user-prompt")
    expect(migration).toBeDefined()
    await migration!.up(() => {})

    const migrated = await Storage.read<Record<string, unknown>>(StoragePath.blueprintLoop(scopeID, loopID))
    expect(migrated.userPrompt).toBeUndefined()
  })

  test("migrates BlueprintLoop ownership into source", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope
    const scopeID = Identifier.asScopeID(scope.id)
    const latticeLoopID = Identifier.ascending("blueprint_loop")
    const userLoopID = Identifier.ascending("blueprint_loop")
    const now = Date.now()

    await Storage.write(StoragePath.blueprintLoop(scopeID, latticeLoopID), {
      ...blueprintLoop({
        id: latticeLoopID,
        noteID: Identifier.ascending("note"),
        sessionID: Identifier.ascending("session"),
        scopeID,
        status: "running",
        updated: now,
      }),
      orchestration: { kind: "lattice", runID: "ltr_legacy" },
    })
    await Storage.write(
      StoragePath.blueprintLoop(scopeID, userLoopID),
      blueprintLoop({
        id: userLoopID,
        noteID: Identifier.ascending("note"),
        sessionID: Identifier.ascending("session"),
        scopeID,
        status: "armed",
        updated: now,
      }),
    )

    const migration = migrations.find((entry) => entry.id === "20260708-blueprint-loop-source")
    expect(migration).toBeDefined()
    await migration!.up(() => {})

    const latticeLoop = await Storage.read<Record<string, unknown>>(StoragePath.blueprintLoop(scopeID, latticeLoopID))
    const userLoop = await Storage.read<Record<string, unknown>>(StoragePath.blueprintLoop(scopeID, userLoopID))

    expect(latticeLoop.source).toBe("lattice")
    expect(userLoop.source).toBe("user")
    expect("orchestration" in latticeLoop).toBe(false)
    expect("orchestration" in userLoop).toBe(false)
  })
  test("blocks rollback while plugin-owned BlueprintLoops exist", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope
    const scopeID = Identifier.asScopeID(scope.id)
    const loopID = Identifier.ascending("blueprint_loop")
    await Storage.write(StoragePath.blueprintLoop(scopeID, loopID), {
      ...blueprintLoop({
        id: loopID,
        noteID: Identifier.ascending("note"),
        sessionID: Identifier.ascending("session"),
        scopeID,
        status: "completed",
        updated: Date.now(),
      }),
      source: "plugin",
      pluginOwner: {
        pluginId: "research-plugin",
        pluginGeneration: "generation-one",
        scopeId: scope.id,
      },
    })

    const migration = migrations.find((entry) => entry.id === "20260715-blueprint-loop-source-plugin")
    expect(migration?.down).toBeDefined()
    await expect(migration!.down!(() => {})).rejects.toThrow("plugin-owned loops exist")
  })
})
