import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { Identifier } from "../../src/id/id"
import { Worktree } from "../../src/project/worktree"
import { Session } from "../../src/session"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { CharterStore } from "../../src/workflow-run/charter-store"
import { WorkflowRunStore } from "../../src/workflow-run/store"
import { WorkflowSeats } from "../../src/workflow-run/seats"
import { WorkflowTypes } from "../../src/workflow-run/types"
import type { Workspace } from "../../src/session/types"

function charter(worktree: WorkflowTypes.WorktreePolicy, pool = 1): WorkflowTypes.Charter {
  return WorkflowTypes.Charter.parse({
    id: `cht_${worktree}`,
    version: 1,
    name: worktree,
    entityType: "task",
    entityInitialState: "working",
    states: ["working", "done", WorkflowTypes.BLOCKED_STATE],
    terminalStates: ["done"],
    seats: [{ name: "executor", agent: "synergy", charterPrompt: "work", pool, worktree }],
    transitions: [],
    gates: [],
    budget: { maxModelCalls: 0 },
    time: { created: Date.now() },
  })
}

describe("seat worktree creation isolation", () => {
  test("adopts a workflow-owned child created before the seat binding was committed", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const definition = charter("none")
        await CharterStore.put(scope.id, definition)
        const boss = await Session.create({ scope })
        const run = await WorkflowRunStore.create({
          scopeID: scope.id,
          charterRef: { id: definition.id, version: definition.version },
          title: "Recover seat",
          bossSessionID: boss.id,
          seats: WorkflowSeats.initialBindings(definition),
          maxModelCalls: 0,
        })
        const orphan = await Session.create({ scope, parentID: boss.id, title: "Interrupted seat creation" })
        await Session.update(orphan.id, (draft) => {
          draft.workflowRun = { runID: run.id, role: "seat", seat: "executor", instance: 0 }
        })
        await Storage.remove(
          StoragePath.sessionChildIndex(Identifier.asScopeID(scope.id), Identifier.asSessionID(boss.id)),
        )

        const adopted = await WorkflowSeats.ensureSession(scope.id, run.id, "executor", 0)

        expect(adopted).toBe(orphan.id)
        expect((await WorkflowRunStore.get(scope.id, run.id)).seats[0]?.sessionID).toBe(orphan.id)
        expect((await Session.children(boss.id)).filter((child) => child.workflowRun?.runID === run.id)).toHaveLength(1)
      },
    })
  })

  test("does not repoint the caller's ambient workspace", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    // Simulate the Boss's live turn: a workspace is bound in the ambient frame.
    const bossWorkspace: Workspace = { type: "main", path: scope.directory, scopeID: scope.id }

    await ScopeContext.provide({
      scope,
      workspace: bossWorkspace,
      fn: async () => {
        const seat = await Session.create({ scope })
        expect(ScopeContext.current.workspace?.path).toBe(bossWorkspace.path)

        await WorkflowSeats.createSeatWorktree(seat.id, "isolation-seat")

        // The ambient workspace must be unchanged — the seat's worktree switch
        // stays confined to its own frame.
        expect(ScopeContext.current.workspace?.path).toBe(bossWorkspace.path)
        expect(ScopeContext.current.workspace?.type).toBe("main")

        // …while the seat session persistently owns the new worktree.
        const seatAfter = await Session.get(seat.id)
        expect(seatAfter.workspace?.type).toBe("git_worktree")
        expect(seatAfter.workspace?.path).not.toBe(bossWorkspace.path)
      },
    })
  })

  test("per_entity worktrees follow the entity and are restored on rework", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const definition = charter("per_entity")
        await CharterStore.put(scope.id, definition)
        const boss = await Session.create({ scope })
        const run = await WorkflowRunStore.create({
          scopeID: scope.id,
          charterRef: { id: definition.id, version: definition.version },
          title: "Per entity",
          bossSessionID: boss.id,
          seats: WorkflowSeats.initialBindings(definition),
          maxModelCalls: 0,
        })
        const now = Date.now()
        const entities: WorkflowTypes.Entity[] = ["wfe_first", "wfe_second"].map((id) => ({
          id,
          runID: run.id,
          title: id,
          state: "working",
          bindings: {},
          submissions: [],
          time: { created: now, updated: now, stateEntered: now },
        }))
        await WorkflowRunStore.update(scope.id, run.id, (draft) => {
          draft.entities.push(...entities)
          draft.entities[0]!.assignedSeat = { seat: "executor", instance: 0 }
          draft.seats[0]!.entityID = entities[0]!.id
        })

        const sessionID = await WorkflowSeats.ensureSession(scope.id, run.id, "executor", 0)
        expect((await Session.get(sessionID)).workspace?.type).not.toBe("git_worktree")
        await WorkflowSeats.prepareWorktree(scope.id, run.id, "executor", 0, entities[0]!.id)
        const firstID = (await WorkflowRunStore.get(scope.id, run.id)).entities[0]!.bindings.worktreeID
        expect(firstID).toBeDefined()

        await WorkflowRunStore.update(scope.id, run.id, (draft) => {
          draft.entities[0]!.assignedSeat = undefined
          draft.entities[1]!.assignedSeat = { seat: "executor", instance: 0 }
          draft.seats[0]!.entityID = entities[1]!.id
        })
        await WorkflowSeats.prepareWorktree(scope.id, run.id, "executor", 0, entities[1]!.id)
        const secondID = (await WorkflowRunStore.get(scope.id, run.id)).entities[1]!.bindings.worktreeID
        expect(secondID).toBeDefined()
        expect(secondID).not.toBe(firstID)

        await WorkflowRunStore.update(scope.id, run.id, (draft) => {
          draft.entities[1]!.assignedSeat = undefined
          draft.entities[0]!.assignedSeat = { seat: "executor", instance: 0 }
          draft.seats[0]!.entityID = entities[0]!.id
        })
        await WorkflowSeats.prepareWorktree(scope.id, run.id, "executor", 0, entities[0]!.id)
        const restored = await Session.get(sessionID)
        expect(restored.workspace?.type).toBe("git_worktree")
        if (restored.workspace?.type === "git_worktree") expect(restored.workspace.worktreeID).toBe(firstID)
      },
    })
  })

  test("per_entity replay adopts the seat-owned worktree created before the entity binding commit", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const definition = charter("per_entity")
        await CharterStore.put(scope.id, definition)
        const boss = await Session.create({ scope })
        const run = await WorkflowRunStore.create({
          scopeID: scope.id,
          charterRef: { id: definition.id, version: definition.version },
          title: "Interrupted per entity",
          bossSessionID: boss.id,
          seats: WorkflowSeats.initialBindings(definition),
          maxModelCalls: 0,
        })
        const now = Date.now()
        const entity: WorkflowTypes.Entity = {
          id: "wfe_interrupted",
          runID: run.id,
          title: "interrupted",
          state: "working",
          bindings: {},
          submissions: [],
          time: { created: now, updated: now, stateEntered: now },
        }
        await WorkflowRunStore.update(scope.id, run.id, (draft) => {
          draft.entities.push(entity)
          draft.entities[0]!.assignedSeat = { seat: "executor", instance: 0 }
          draft.seats[0]!.entityID = entity.id
        })
        const sessionID = await WorkflowSeats.ensureSession(scope.id, run.id, "executor", 0)
        const interrupted = await Worktree.create({
          sessionID,
          name: "interrupted-per-entity",
          baseRef: "current",
          bind: true,
        })

        expect((await WorkflowRunStore.get(scope.id, run.id)).entities[0]!.bindings.worktreeID).toBeUndefined()

        await WorkflowSeats.prepareWorktree(scope.id, run.id, "executor", 0, entity.id)

        const recovered = await WorkflowRunStore.get(scope.id, run.id)
        expect(recovered.entities[0]!.bindings.worktreeID).toBe(interrupted.id)
        expect(interrupted.resolvedBaseCommit).toBeDefined()
        expect(recovered.entities[0]!.bindings.baseCommit).toBe(interrupted.resolvedBaseCommit!)
        expect((await Session.get(sessionID)).workspace?.worktreeID).toBe(interrupted.id)
        expect(
          (await Worktree.list()).filter(
            (item) => item.managed && item.owner?.type === "session" && item.owner.sessionID === sessionID,
          ),
        ).toHaveLength(1)
      },
    })
  })

  test("shared worktrees are created once for the seat session", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const definition = charter("shared")
        await CharterStore.put(scope.id, definition)
        const boss = await Session.create({ scope })
        const run = await WorkflowRunStore.create({
          scopeID: scope.id,
          charterRef: { id: definition.id, version: definition.version },
          title: "Shared",
          bossSessionID: boss.id,
          seats: WorkflowSeats.initialBindings(definition),
          maxModelCalls: 0,
        })

        const firstSessionID = await WorkflowSeats.ensureSession(scope.id, run.id, "executor", 0)
        const first = await Session.get(firstSessionID)
        expect(first.workspace?.type).toBe("git_worktree")
        const secondSessionID = await WorkflowSeats.ensureSession(scope.id, run.id, "executor", 0)
        const second = await Session.get(secondSessionID)
        expect(secondSessionID).toBe(firstSessionID)
        expect(second.workspace).toEqual(first.workspace)
      },
    })
  })

  test("shared seats replace an inherited Boss worktree with one owned workspace per seat instance", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const definition = charter("shared", 2)
        await CharterStore.put(scope.id, definition)
        const boss = await Session.create({ scope })
        const bossWorktree = await Worktree.create({
          sessionID: boss.id,
          name: "boss-worktree",
          baseRef: "current",
          bind: true,
        })
        const run = await WorkflowRunStore.create({
          scopeID: scope.id,
          charterRef: { id: definition.id, version: definition.version },
          title: "Shared ownership",
          bossSessionID: boss.id,
          seats: WorkflowSeats.initialBindings(definition),
          maxModelCalls: 0,
        })

        const firstSessionID = await WorkflowSeats.ensureSession(scope.id, run.id, "executor", 0)
        const secondSessionID = await WorkflowSeats.ensureSession(scope.id, run.id, "executor", 1)
        const first = await Session.get(firstSessionID)
        const second = await Session.get(secondSessionID)
        expect(first.workspace?.worktreeID).toBeDefined()
        expect(second.workspace?.worktreeID).toBeDefined()
        expect(first.workspace?.worktreeID).not.toBe(bossWorktree.id)
        expect(second.workspace?.worktreeID).not.toBe(bossWorktree.id)
        expect(first.workspace?.worktreeID).not.toBe(second.workspace?.worktreeID)

        const worktrees = await Worktree.list()
        expect(worktrees.find((item) => item.id === first.workspace?.worktreeID)?.owner).toEqual({
          type: "session",
          sessionID: firstSessionID,
        })
        expect(worktrees.find((item) => item.id === second.workspace?.worktreeID)?.owner).toEqual({
          type: "session",
          sessionID: secondSessionID,
        })
      },
    })
  })
})
