import { describe, expect, setDefaultTimeout, test } from "bun:test"
import z from "zod"
import { Bus } from "../../src/bus"
import { LatticeAction } from "../../src/lattice/action"
import { LatticeActionService } from "../../src/lattice/action-service"
import { LatticeError } from "../../src/lattice/error"
import { LatticeEvent } from "../../src/lattice/event"
import { ProviderTransform } from "../../src/provider/transform"
import { tmpdir } from "../fixture/fixture"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { LatticeStore } from "../../src/lattice/store"
import { Identifier } from "../../src/id/id"
import { LatticeTypes } from "../../src/lattice/types"
import { NoteDocument, NoteStore } from "../../src/note"

setDefaultTimeout(30_000)

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn })
}

describe("LatticeAction public contract", () => {
  test("uses a provider-compatible object root while preserving a strict internal union", () => {
    const jsonSchema = z.toJSONSchema(LatticeAction.ToolInput)
    expect(jsonSchema.type).toBe("object")
    expect(() =>
      ProviderTransform.schema({ providerID: "openai", api: { id: "gpt-4.1" } } as any, jsonSchema as any, {
        tool: "lattice_submit",
      }),
    ).not.toThrow()

    expect(
      LatticeAction.parseToolInput({
        action: "submit_requirements",
        goal: "Ship safely",
        successCriteria: ["all checks pass"],
      }),
    ).toEqual({
      action: "submit_requirements",
      goal: "Ship safely",
      successCriteria: ["all checks pass"],
    })
  })

  test("rejects missing branch fields and fields from another action", () => {
    expect(() => LatticeAction.parseToolInput({ action: "submit_blueprint" })).toThrow()
    expect(() =>
      LatticeAction.parseToolInput({
        action: "submit_blueprint",
        blueprintID: "note_blueprint",
        reason: "not valid for this branch",
      }),
    ).toThrow()
  })

  test("persists a semantic action without changing state and treats an exact retry as idempotent", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const scopeID = ScopeContext.current.scope.id
      await LatticeStore.create({ sessionID: session.id, mode: "auto" })
      const input = LatticeAction.Input.parse({
        action: "submit_requirements",
        goal: "Ship safely",
        successCriteria: ["tests pass"],
      })

      const first = await LatticeActionService.submit({ scopeID, sessionID: session.id, source: "agent", input })
      const retried = await LatticeActionService.submit({ scopeID, sessionID: session.id, source: "agent", input })

      expect(first.state).toBe("clarifying")
      expect(first.pendingAction?.kind).toBe("submit_requirements")
      expect(retried.pendingAction?.id).toBe(first.pendingAction?.id)
    })
  })

  test("reports whether a semantic action was newly queued or was already durably queued", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const scopeID = ScopeContext.current.scope.id
      await LatticeStore.create({ sessionID: session.id, mode: "auto" })
      const input = LatticeAction.Input.parse({
        action: "submit_requirements",
        goal: "Ship safely",
        successCriteria: ["tests pass"],
      })

      const first = await LatticeActionService.submitWithResult({
        scopeID,
        sessionID: session.id,
        source: "agent",
        input,
      })
      const duplicate = await LatticeActionService.submitWithResult({
        scopeID,
        sessionID: session.id,
        source: "agent",
        input,
      })

      expect(first.disposition).toBe("queued")
      expect(duplicate.disposition).toBe("already_queued")
      expect(duplicate.run.pendingAction?.id).toBe(first.run.pendingAction?.id)
    })
  })

  test("atomically deduplicates concurrent semantic retries without revision or update-event churn", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const scopeID = ScopeContext.current.scope.id
      const run = await LatticeStore.create({ sessionID: session.id, mode: "auto" })
      const input = LatticeAction.Input.parse({
        action: "submit_requirements",
        goal: "Ship safely",
        successCriteria: ["tests pass"],
      })
      const revisions: number[] = []
      const unsubscribe = Bus.subscribe(LatticeEvent.Updated, (event) => {
        if (event.properties.run.id === run.id) revisions.push(event.properties.run.revision)
      })

      try {
        const submitted = await Promise.all(
          Array.from({ length: 16 }, () =>
            LatticeActionService.submit({ scopeID, sessionID: session.id, source: "agent", input }),
          ),
        )

        expect(new Set(submitted.map((candidate) => candidate.pendingAction?.id)).size).toBe(1)
        expect(submitted.every((candidate) => candidate.revision === 1)).toBe(true)
        expect(revisions).toEqual([1])
      } finally {
        unsubscribe()
      }
    })
  })

  test("atomically rejects one of two concurrent conflicting semantic actions", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const scopeID = ScopeContext.current.scope.id
      await LatticeStore.create({ sessionID: session.id, mode: "auto" })

      const results = await Promise.allSettled([
        LatticeActionService.submit({
          scopeID,
          sessionID: session.id,
          source: "agent",
          input: { action: "submit_requirements", goal: "A", successCriteria: ["A"] },
        }),
        LatticeActionService.submit({
          scopeID,
          sessionID: session.id,
          source: "agent",
          input: { action: "submit_requirements", goal: "B", successCriteria: ["B"] },
        }),
      ])

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
      const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
      expect(rejected?.reason).toBeInstanceOf(LatticeError.StateConflict)
      expect((await LatticeStore.get(scopeID, session.id)).revision).toBe(1)
    })
  })

  test("rejects a conflicting pending action and an action for the wrong state", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const scopeID = ScopeContext.current.scope.id
      await LatticeStore.create({ sessionID: session.id, mode: "auto" })
      await LatticeActionService.submit({
        scopeID,
        sessionID: session.id,
        source: "agent",
        input: { action: "submit_requirements", goal: "A", successCriteria: ["A"] },
      })

      await expect(
        LatticeActionService.submit({
          scopeID,
          sessionID: session.id,
          source: "agent",
          input: { action: "submit_requirements", goal: "B", successCriteria: ["B"] },
        }),
      ).rejects.toThrow()
      await expect(
        LatticeActionService.submit({
          scopeID,
          sessionID: session.id,
          source: "agent",
          input: { action: "submit_pathway", reason: "too early" },
        }),
      ).rejects.toThrow()
    })
  })

  test("rejects Panel approval when the reviewed Blueprint version changed", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const scopeID = ScopeContext.current.scope.id
      const note = await NoteStore.create({ title: "Reviewed Blueprint", kind: "blueprint" })
      const digest = NoteDocument.hash(note.content)
      const run = await LatticeStore.create({ sessionID: session.id, mode: "collaborative" })
      const stepID = Identifier.ascending("lattice_step")
      await LatticeStore.updateByRunID(scopeID, run.id, (draft) => {
        draft.state = "awaiting_execution"
        draft.currentStepID = stepID
        draft.pathway = [
          LatticeTypes.Step.parse({
            id: stepID,
            title: "Execute",
            objective: "Execute the reviewed Blueprint",
            status: "current",
            acceptanceCriteria: [],
            assumptions: [],
            blueprint: {
              noteID: note.id,
              boundVersion: note.version,
              contentDigest: digest,
              reviewedVersion: note.version,
              reviewedContentDigest: digest,
              time: { bound: Date.now(), reviewed: Date.now() },
            },
            blueprintHistory: [],
            loopHistory: [],
            time: { created: Date.now(), updated: Date.now() },
          }),
        ]
      })
      await NoteStore.update(scopeID, note.id, { expectedVersion: note.version })

      await expect(
        LatticeActionService.submit({
          scopeID,
          sessionID: session.id,
          source: "panel",
          input: { action: "approve_execution", reason: "Approved in Lattice Panel" },
        }),
      ).rejects.toMatchObject({ data: { state: "awaiting_execution" } })
    })
  })
})
