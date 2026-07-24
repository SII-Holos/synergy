import { describe, expect, spyOn, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { migrations } from "../../src/lattice/migration"
import { LatticeTypes } from "../../src/lattice/types"
import { Scope } from "../../src/scope"
import { StoragePath } from "../../src/storage/path"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../fixture/fixture"

function legacyRunPath(scopeID: string, sessionID: string) {
  return StoragePath.latticeLegacyRun(Identifier.asScopeID(scopeID), sessionID)
}

function legacyEventsRoot(scopeID: string, sessionID: string) {
  return StoragePath.latticeLegacyEventsRoot(Identifier.asScopeID(scopeID), sessionID)
}

function legacyEventPath(scopeID: string, sessionID: string, eventID: string) {
  return StoragePath.latticeLegacyEvent(Identifier.asScopeID(scopeID), sessionID, eventID)
}

function resetMigration() {
  const migration = migrations.find((entry) => entry.id === "20260722-lattice-v2-reset")
  expect(migration).toBeDefined()
  return migration!
}

describe("Lattice v2 reset migration", () => {
  test("preserves a strict v2 run, its events, and its current Session binding", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope
    const scopeID = Identifier.asScopeID(scope.id)
    const sessionID = Identifier.ascending("session")
    const runID = Identifier.ascending("lattice_run")
    const eventID = Identifier.ascending("lattice_event")
    const now = Date.now()
    const run = LatticeTypes.Run.parse({
      schemaVersion: 2,
      id: runID,
      scopeID: scope.id,
      sessionID,
      mode: "collaborative",
      maxModelCalls: 0,
      modelCallCount: 0,
      status: "active",
      state: "clarifying",
      revision: 0,
      stateRevision: 0,
      pathwayRevision: 0,
      pathway: [],
      time: { created: now, updated: now },
    })
    const event = LatticeTypes.EventInfo.parse({
      id: eventID,
      runID,
      scopeID: scope.id,
      sessionID,
      kind: "run_created",
      state: "clarifying",
      time: { created: now },
    })
    const runPath = StoragePath.latticeRun(scopeID, runID)
    const eventPath = StoragePath.latticeEvent(scopeID, runID, eventID)
    await Storage.write(runPath, run)
    await Storage.write(eventPath, event)
    await Storage.write(StoragePath.sessionInfo(scopeID, sessionID), {
      id: sessionID,
      scope: { id: scope.id },
      workflow: { kind: "lattice", runID, mode: "collaborative" },
    })

    await resetMigration().up(() => {})

    expect(await Storage.read<LatticeTypes.Run>(runPath)).toEqual(run)
    expect(await Storage.read<LatticeTypes.EventInfo>(eventPath)).toEqual(event)
    expect(await Storage.read<Record<string, unknown>>(StoragePath.sessionInfo(scopeID, sessionID))).toMatchObject({
      workflow: { kind: "lattice", runID, mode: "collaborative" },
    })
  })

  test("does not cancel or unbind a source-lattice loop owned by a strict v2 run", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope
    const scopeID = Identifier.asScopeID(scope.id)
    const sessionID = Identifier.ascending("session")
    const runID = Identifier.ascending("lattice_run")
    const legacyRunID = Identifier.ascending("lattice_run")
    const stepID = Identifier.ascending("lattice_step")
    const loopID = Identifier.ascending("blueprint_loop")
    const noteID = Identifier.ascending("note")
    const now = Date.now()
    const run = LatticeTypes.Run.parse({
      schemaVersion: 2,
      id: runID,
      scopeID: scope.id,
      sessionID,
      mode: "auto",
      maxModelCalls: 0,
      modelCallCount: 1,
      status: "active",
      state: "executing",
      currentStepID: stepID,
      revision: 4,
      stateRevision: 3,
      pathwayRevision: 1,
      pathway: [
        {
          id: stepID,
          title: "Current v2 step",
          objective: "Keep the v2-owned loop",
          status: "executing",
          acceptanceCriteria: ["The loop remains active"],
          assumptions: [],
          blueprint: {
            noteID,
            boundVersion: 2,
            contentDigest: "v2-digest",
            reviewedVersion: 2,
            reviewedContentDigest: "v2-digest",
            time: { bound: now, reviewed: now },
          },
          blueprintHistory: [],
          loopHistory: [
            {
              loopID,
              status: "running",
              sourceDigest: "v2-digest",
              time: { created: now, started: now },
            },
          ],
          time: { created: now, updated: now, started: now },
        },
      ],
      time: { created: now, updated: now },
    })
    const loop = {
      id: loopID,
      noteID,
      noteVersion: 2,
      title: "Current v2 loop",
      sessionID,
      auditAgent: "supervisor",
      scopeID: scope.id,
      status: "running",
      source: "lattice",
      sourceDigest: "v2-digest",
      orchestration: { kind: "lattice", runID },
      time: { created: now, updated: now, started: now },
    }
    const note = {
      id: noteID,
      title: "Current Blueprint",
      content: { type: "doc", content: [] },
      kind: "blueprint",
      blueprint: { activeLoopID: loopID },
      version: 2,
      time: { created: now, updated: now },
    }

    await Storage.write(StoragePath.latticeRun(scopeID, runID), run)
    await Storage.write(legacyRunPath(scope.id, sessionID), {
      id: legacyRunID,
      scopeID: scope.id,
      sessionID,
      status: "active",
      phase: "broken",
      pathway: [{ blueprintLoopID: loopID }],
    })
    await Storage.write(StoragePath.blueprintLoop(scopeID, loopID), loop)
    await Storage.write(StoragePath.note(scopeID, noteID), note)
    await Storage.write(StoragePath.sessionInfo(scopeID, sessionID), {
      id: sessionID,
      scope: { id: scope.id },
      workflow: { kind: "lattice", runID, mode: "auto" },
      blueprint: { loopID, loopRole: "execution" },
    })

    await resetMigration().up(() => {})

    await expect(Storage.read(legacyRunPath(scope.id, sessionID))).rejects.toBeInstanceOf(Storage.NotFoundError)
    expect(await Storage.read<LatticeTypes.Run>(StoragePath.latticeRun(scopeID, runID))).toEqual(run)
    expect(await Storage.read<typeof loop>(StoragePath.blueprintLoop(scopeID, loopID))).toEqual(loop)
    expect(await Storage.read<typeof note>(StoragePath.note(scopeID, noteID))).toEqual(note)
    expect(await Storage.read<Record<string, unknown>>(StoragePath.sessionInfo(scopeID, sessionID))).toMatchObject({
      workflow: { kind: "lattice", runID, mode: "auto" },
      blueprint: { loopID, loopRole: "execution" },
    })
  })

  test("resets a v1 run and its exact Lattice-owned active loop while preserving Blueprint content", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope
    const scopeID = Identifier.asScopeID(scope.id)
    const sessionID = Identifier.ascending("session")
    const runID = Identifier.ascending("lattice_run")
    const stepID = Identifier.ascending("lattice_step")
    const loopID = Identifier.ascending("blueprint_loop")
    const noteID = Identifier.ascending("note")
    const auditSessionID = Identifier.ascending("session")
    const eventID = Identifier.ascending("lattice_event")
    const now = Date.now()
    const content = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Keep this Blueprint" }] }],
    }

    await Storage.write(legacyRunPath(scope.id, sessionID), {
      id: runID,
      scopeID: scope.id,
      sessionID,
      mode: "auto",
      maxModelCalls: 0,
      modelCallCount: 2,
      status: "active",
      phase: "blueprint_execution",
      currentStepID: stepID,
      firstBlueprintStarted: true,
      assumptions: [],
      pathway: [
        {
          id: stepID,
          title: "Execute",
          objective: "Execute the Blueprint",
          status: "running",
          acceptanceCriteria: [],
          assumptions: [],
          blueprintNoteID: noteID,
          blueprintLoopID: loopID,
          time: { created: now, updated: now, started: now },
        },
      ],
      time: { created: now, updated: now },
    })
    await Storage.write(legacyEventPath(scope.id, sessionID, eventID), {
      id: eventID,
      runID,
      scopeID: scope.id,
      sessionID,
      kind: "step_started",
      stepID,
      time: { created: now },
    })
    await Storage.write(StoragePath.sessionInfo(scopeID, sessionID), {
      id: sessionID,
      scope: { id: scope.id, directory: scope.directory, worktree: scope.worktree },
      workflow: { kind: "lattice", runID, mode: "auto", firstBlueprintStarted: true },
      lattice: { runID, mode: "auto", firstBlueprintStarted: true },
      blueprint: { loopID, loopRole: "execution" },
    })
    await Storage.write(StoragePath.sessionInfo(scopeID, auditSessionID), {
      id: auditSessionID,
      scope: { id: scope.id, directory: scope.directory, worktree: scope.worktree },
      blueprint: { loopID, loopRole: "audit" },
    })
    await Storage.write(StoragePath.blueprintLoop(scopeID, loopID), {
      id: loopID,
      noteID,
      title: "Execute",
      sessionID,
      auditAgent: "supervisor",
      auditSessionID,
      scopeID: scope.id,
      status: "running",
      source: "lattice",
      time: { created: now, updated: now },
    })
    await Storage.write(StoragePath.note(scopeID, noteID), {
      id: noteID,
      title: "Blueprint",
      content,
      kind: "blueprint",
      blueprint: { activeLoopID: loopID, description: "Preserve metadata" },
      version: 4,
      time: { created: now, updated: now },
    })

    const migration = resetMigration()
    await migration.up(() => {})

    await expect(Storage.read(legacyRunPath(scope.id, sessionID))).rejects.toBeInstanceOf(Storage.NotFoundError)
    expect(await Storage.scan(legacyEventsRoot(scope.id, sessionID))).toEqual([])

    const loop = await Storage.read<Record<string, unknown>>(StoragePath.blueprintLoop(scopeID, loopID))
    expect(loop.status).toBe("cancelled")
    expect(loop.time).toMatchObject({ updated: expect.any(Number), completed: expect.any(Number) })

    const session = await Storage.read<Record<string, unknown>>(StoragePath.sessionInfo(scopeID, sessionID))
    expect(session.workflow).toBeUndefined()
    expect(session.lattice).toBeUndefined()
    expect(session.blueprint).toBeUndefined()
    expect(
      (await Storage.read<Record<string, unknown>>(StoragePath.sessionInfo(scopeID, auditSessionID))).blueprint,
    ).toBeUndefined()

    const note = await Storage.read<Record<string, unknown>>(StoragePath.note(scopeID, noteID))
    expect(note.content).toEqual(content)
    expect(note.version).toBe(4)
    expect(note.blueprint).toEqual({ description: "Preserve metadata" })

    await migration.up(() => {})
    expect(await Storage.read<Record<string, unknown>>(StoragePath.blueprintLoop(scopeID, loopID))).toEqual(loop)
    expect(await Storage.read<Record<string, unknown>>(StoragePath.note(scopeID, noteID))).toEqual(note)
  })

  test("does not cancel or unbind a foreign loop referenced by corrupt v1 state", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope
    const scopeID = Identifier.asScopeID(scope.id)
    const sessionID = Identifier.ascending("session")
    const runID = Identifier.ascending("lattice_run")
    const loopID = Identifier.ascending("blueprint_loop")
    const noteID = Identifier.ascending("note")
    const now = Date.now()

    await Storage.write(legacyRunPath(scope.id, sessionID), {
      id: runID,
      scopeID: scope.id,
      sessionID,
      status: "active",
      phase: "unknown_phase",
      pathway: [{ blueprintLoopID: loopID }],
    })
    await Storage.write(StoragePath.sessionInfo(scopeID, sessionID), {
      id: sessionID,
      scope: { id: scope.id },
      workflow: { kind: "lattice", runID, mode: "collaborative" },
      blueprint: { loopID, loopRole: "execution" },
    })
    const foreignLoop = {
      id: loopID,
      noteID,
      title: "User loop",
      sessionID,
      auditAgent: "supervisor",
      scopeID: scope.id,
      status: "running",
      source: "user",
      time: { created: now, updated: now },
    }
    await Storage.write(StoragePath.blueprintLoop(scopeID, loopID), foreignLoop)
    const note = {
      id: noteID,
      title: "Blueprint",
      content: { type: "doc", content: [] },
      kind: "blueprint",
      blueprint: { activeLoopID: loopID },
      version: 1,
      time: { created: now, updated: now },
    }
    await Storage.write(StoragePath.note(scopeID, noteID), note)

    await resetMigration().up(() => {})

    await expect(Storage.read(legacyRunPath(scope.id, sessionID))).rejects.toBeInstanceOf(Storage.NotFoundError)
    expect(await Storage.read<typeof foreignLoop>(StoragePath.blueprintLoop(scopeID, loopID))).toEqual(foreignLoop)
    expect(await Storage.read<typeof note>(StoragePath.note(scopeID, noteID))).toEqual(note)

    const session = await Storage.read<Record<string, unknown>>(StoragePath.sessionInfo(scopeID, sessionID))
    expect(session.workflow).toBeUndefined()
    expect(session.blueprint).toEqual({ loopID, loopRole: "execution" })
  })

  test("does not treat source lattice as ownership when orchestration names another Run", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope
    const scopeID = Identifier.asScopeID(scope.id)
    const sessionID = Identifier.ascending("session")
    const runID = Identifier.ascending("lattice_run")
    const ownerRunID = Identifier.ascending("lattice_run")
    const loopID = Identifier.ascending("blueprint_loop")
    const now = Date.now()

    await Storage.write(legacyRunPath(scope.id, sessionID), {
      id: runID,
      scopeID: scope.id,
      sessionID,
      status: "active",
      pathway: [{ blueprintLoopID: loopID }],
    })
    await Storage.write(StoragePath.sessionInfo(scopeID, sessionID), {
      id: sessionID,
      scope: { id: scope.id },
      workflow: { kind: "lattice", runID, mode: "auto" },
      blueprint: { loopID, loopRole: "execution" },
    })
    const loop = {
      id: loopID,
      noteID: Identifier.ascending("note"),
      title: "Different Lattice owner",
      sessionID,
      auditAgent: "supervisor",
      scopeID: scope.id,
      status: "running",
      source: "lattice",
      orchestration: { kind: "lattice", runID: ownerRunID },
      time: { created: now, updated: now },
    }
    await Storage.write(StoragePath.blueprintLoop(scopeID, loopID), loop)

    await resetMigration().up(() => {})

    expect(await Storage.read<typeof loop>(StoragePath.blueprintLoop(scopeID, loopID))).toEqual(loop)
    expect(await Storage.read<Record<string, unknown>>(StoragePath.sessionInfo(scopeID, sessionID))).toMatchObject({
      blueprint: { loopID, loopRole: "execution" },
    })
  })

  test("recognizes pre-source-migration Lattice loop ownership without depending on domain order", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope
    const scopeID = Identifier.asScopeID(scope.id)
    const sessionID = Identifier.ascending("session")
    const runID = Identifier.ascending("lattice_run")
    const loopID = Identifier.ascending("blueprint_loop")
    const now = Date.now()

    await Storage.write(legacyRunPath(scope.id, sessionID), {
      id: runID,
      scopeID: scope.id,
      sessionID,
      status: "active",
      pathway: [{ blueprintLoopID: loopID }],
    })
    await Storage.write(StoragePath.sessionInfo(scopeID, sessionID), {
      id: sessionID,
      scope: { id: scope.id },
      lattice: { runID, mode: "auto" },
      blueprint: { loopID, loopRole: "execution" },
    })
    await Storage.write(StoragePath.blueprintLoop(scopeID, loopID), {
      id: loopID,
      noteID: Identifier.ascending("note"),
      title: "Legacy Lattice loop",
      sessionID,
      auditAgent: "supervisor",
      scopeID: scope.id,
      status: "armed",
      orchestration: { kind: "lattice", runID },
      time: { created: now, updated: now },
    })

    await resetMigration().up(() => {})

    expect(await Storage.read<Record<string, unknown>>(StoragePath.blueprintLoop(scopeID, loopID))).toMatchObject({
      status: "cancelled",
      orchestration: { kind: "lattice", runID },
      time: { completed: expect.any(Number) },
    })
    expect(await Storage.read<Record<string, unknown>>(StoragePath.sessionInfo(scopeID, sessionID))).not.toHaveProperty(
      "lattice",
    )
  })

  test("deletes malformed v1 records and legacy events without touching unrelated session state", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope
    const scopeID = Identifier.asScopeID(scope.id)
    const sessionID = Identifier.ascending("session")
    const eventID = Identifier.ascending("lattice_event")

    await Storage.write(legacyRunPath(scope.id, sessionID), { phase: "broken" })
    await Storage.write(legacyEventPath(scope.id, sessionID, eventID), { malformed: true })
    await Storage.write(StoragePath.sessionInfo(scopeID, sessionID), {
      id: sessionID,
      scope: { id: scope.id },
      title: "Keep me",
      lattice: { mode: "auto", runID: "ltr_missing" },
      workflow: { kind: "plan" },
    })

    await resetMigration().up(() => {})

    await expect(Storage.read(legacyRunPath(scope.id, sessionID))).rejects.toBeInstanceOf(Storage.NotFoundError)
    expect(await Storage.scan(legacyEventsRoot(scope.id, sessionID))).toEqual([])
    expect(await Storage.read<Record<string, unknown>>(StoragePath.sessionInfo(scopeID, sessionID))).toMatchObject({
      title: "Keep me",
      workflow: { kind: "plan" },
    })
    expect((await Storage.read<Record<string, unknown>>(StoragePath.sessionInfo(scopeID, sessionID))).lattice).toBe(
      undefined,
    )
  })

  test("cleans an orphan legacy Session and its exact loop without a v1 Run record", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope
    const scopeID = Identifier.asScopeID(scope.id)
    const sessionID = Identifier.ascending("session")
    const auditSessionID = Identifier.ascending("session")
    const runID = Identifier.ascending("lattice_run")
    const loopID = Identifier.ascending("blueprint_loop")
    const noteID = Identifier.ascending("note")
    const now = Date.now()
    const content = { type: "doc", content: [{ type: "paragraph" }] }

    await Storage.write(StoragePath.sessionInfo(scopeID, sessionID), {
      id: sessionID,
      scope: { id: scope.id },
      workflow: { kind: "lattice", runID, mode: "collaborative" },
      lattice: { runID, mode: "collaborative" },
      blueprint: { loopID, loopRole: "execution" },
    })
    await Storage.write(StoragePath.sessionInfo(scopeID, auditSessionID), {
      id: auditSessionID,
      scope: { id: scope.id },
      blueprint: { loopID, loopRole: "audit" },
    })
    await Storage.write(StoragePath.blueprintLoop(scopeID, loopID), {
      id: loopID,
      noteID,
      title: "Orphan legacy loop",
      sessionID,
      auditAgent: "supervisor",
      auditSessionID,
      scopeID: scope.id,
      status: "auditing",
      source: "lattice",
      orchestration: { kind: "lattice", runID },
      time: { created: now, updated: now },
    })
    await Storage.write(StoragePath.note(scopeID, noteID), {
      id: noteID,
      title: "Orphan Blueprint",
      content,
      kind: "blueprint",
      blueprint: { activeLoopID: loopID, description: "Keep metadata" },
      version: 3,
      time: { created: now, updated: now },
    })

    const migration = resetMigration()
    await migration.up(() => {})

    const loop = await Storage.read<Record<string, unknown>>(StoragePath.blueprintLoop(scopeID, loopID))
    expect(loop).toMatchObject({ status: "cancelled", time: { completed: expect.any(Number) } })
    const execution = await Storage.read<Record<string, unknown>>(StoragePath.sessionInfo(scopeID, sessionID))
    expect(execution.workflow).toBeUndefined()
    expect(execution.lattice).toBeUndefined()
    expect(execution.blueprint).toBeUndefined()
    expect(
      (await Storage.read<Record<string, unknown>>(StoragePath.sessionInfo(scopeID, auditSessionID))).blueprint,
    ).toBeUndefined()
    const note = await Storage.read<Record<string, unknown>>(StoragePath.note(scopeID, noteID))
    expect(note.content).toEqual(content)
    expect(note.version).toBe(3)
    expect(note.blueprint).toEqual({ description: "Keep metadata" })

    await migration.up(() => {})
    expect(await Storage.read<Record<string, unknown>>(StoragePath.blueprintLoop(scopeID, loopID))).toEqual(loop)
    expect(await Storage.read<Record<string, unknown>>(StoragePath.note(scopeID, noteID))).toEqual(note)
  })

  test("finishes audit binding cleanup after its first Storage write fails", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope
    const scopeID = Identifier.asScopeID(scope.id)
    const sessionID = Identifier.ascending("session")
    const auditSessionID = Identifier.ascending("session")
    const runID = Identifier.ascending("lattice_run")
    const loopID = Identifier.ascending("blueprint_loop")
    const noteID = Identifier.ascending("note")
    const now = Date.now()
    const auditSessionPath = StoragePath.sessionInfo(scopeID, auditSessionID)

    await Storage.write(StoragePath.sessionInfo(scopeID, sessionID), {
      id: sessionID,
      scope: { id: scope.id },
      workflow: { kind: "lattice", runID, mode: "collaborative" },
      blueprint: { loopID, loopRole: "execution" },
    })
    await Storage.write(auditSessionPath, {
      id: auditSessionID,
      scope: { id: scope.id },
      blueprint: { loopID, loopRole: "audit" },
    })
    await Storage.write(StoragePath.blueprintLoop(scopeID, loopID), {
      id: loopID,
      noteID,
      title: "Partially reset audit loop",
      sessionID,
      auditAgent: "supervisor",
      auditSessionID,
      scopeID: scope.id,
      status: "auditing",
      source: "lattice",
      orchestration: { kind: "lattice", runID },
      time: { created: now, updated: now },
    })

    const originalWrite = Storage.write
    let failAuditWrite = true
    using _write = spyOn(Storage, "write").mockImplementation(async (key, content, options) => {
      if (failAuditWrite && key.join("/") === auditSessionPath.join("/")) {
        failAuditWrite = false
        throw new Error("injected audit Session write failure")
      }
      return originalWrite(key, content, options)
    })

    const migration = resetMigration()
    await expect(migration.up(() => {})).rejects.toThrow("injected audit Session write failure")
    expect(
      (await Storage.read<Record<string, unknown>>(StoragePath.sessionInfo(scopeID, sessionID))).blueprint,
    ).toBeUndefined()
    expect(await Storage.read<Record<string, unknown>>(auditSessionPath)).toMatchObject({
      blueprint: { loopID, loopRole: "audit" },
    })

    await migration.up(() => {})

    expect((await Storage.read<Record<string, unknown>>(auditSessionPath)).blueprint).toBeUndefined()
    expect(await Storage.read<Record<string, unknown>>(StoragePath.blueprintLoop(scopeID, loopID))).toMatchObject({
      status: "cancelled",
    })
  })

  test("finishes orphan loop cleanup after a partial run already removed legacy Session fields", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope
    const scopeID = Identifier.asScopeID(scope.id)
    const sessionID = Identifier.ascending("session")
    const loopID = Identifier.ascending("blueprint_loop")
    const noteID = Identifier.ascending("note")
    const now = Date.now()

    await Storage.write(StoragePath.sessionInfo(scopeID, sessionID), {
      id: sessionID,
      scope: { id: scope.id },
      blueprint: { loopID, loopRole: "execution" },
    })
    await Storage.write(StoragePath.blueprintLoop(scopeID, loopID), {
      id: loopID,
      noteID,
      title: "Partially reset legacy loop",
      sessionID,
      auditAgent: "supervisor",
      scopeID: scope.id,
      status: "running",
      source: "lattice",
      time: { created: now, updated: now },
    })
    await Storage.write(StoragePath.note(scopeID, noteID), {
      id: noteID,
      title: "Blueprint",
      content: { type: "doc", content: [] },
      kind: "blueprint",
      blueprint: { activeLoopID: loopID },
      version: 1,
      time: { created: now, updated: now },
    })

    await resetMigration().up(() => {})

    expect(await Storage.read<Record<string, unknown>>(StoragePath.blueprintLoop(scopeID, loopID))).toMatchObject({
      status: "cancelled",
    })
    expect(
      (await Storage.read<Record<string, unknown>>(StoragePath.sessionInfo(scopeID, sessionID))).blueprint,
    ).toBeUndefined()
    expect((await Storage.read<Record<string, unknown>>(StoragePath.note(scopeID, noteID))).blueprint).toEqual({})
  })

  test("does not let an orphan malformed record clear a strict v2 workflow binding", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope
    const scopeID = Identifier.asScopeID(scope.id)
    const sessionID = Identifier.ascending("session")
    const runID = Identifier.ascending("lattice_run")
    const now = Date.now()
    const run = LatticeTypes.Run.parse({
      schemaVersion: 2,
      id: runID,
      scopeID: scope.id,
      sessionID,
      mode: "auto",
      maxModelCalls: 0,
      modelCallCount: 0,
      status: "active",
      state: "clarifying",
      revision: 0,
      stateRevision: 0,
      pathwayRevision: 0,
      pathway: [],
      time: { created: now, updated: now },
    })
    await Storage.write(StoragePath.latticeRun(scopeID, run.id), run)
    await Storage.write(legacyRunPath(scope.id, sessionID), { phase: "broken" })
    await Storage.write(StoragePath.sessionInfo(scopeID, sessionID), {
      id: sessionID,
      scope: { id: scope.id },
      workflow: { kind: "lattice", runID, mode: "auto" },
    })

    await resetMigration().up(() => {})

    expect(await Storage.read<LatticeTypes.Run>(StoragePath.latticeRun(scopeID, runID))).toEqual(run)
    expect(await Storage.read<Record<string, unknown>>(StoragePath.sessionInfo(scopeID, sessionID))).toMatchObject({
      workflow: { kind: "lattice", runID, mode: "auto" },
    })
  })
})
