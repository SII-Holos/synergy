import { expect, test } from "bun:test"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import {
  SessionTransferOwners as Owners,
  SessionTransferEpochs as Epochs,
} from "@ericsanchezok/synergy-harness/session/transfer"
import { NoteStore } from "@ericsanchezok/synergy-note"
import { LatticeStore } from "../src/lattice/store"
import { LatticeModelCalls } from "../src/lattice/model-calls"
import { testRuntime } from "./support/runtime"

test("Lattice handoff retains every native run, versions and pending effect while flushing its real model counter", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null })
        const old = await LatticeStore.create({ sessionID: session.id, mode: "auto" })
        await LatticeStore.updateByRunID("home", old.id, (draft) => {
          draft.status = "completed"
          draft.time.completed = Date.now()
        })
        const current = await LatticeStore.create({ sessionID: session.id, mode: "collaborative" })
        const document = await NoteStore.create({ title: "Bound original document", kind: "blueprint" })
        const now = Date.now()
        const effect = {
          id: Identifier.ascending("lattice_effect"),
          kind: "deliver_prompt" as const,
          promptType: "state_entry" as const,
          state: "clarifying" as const,
          deliveryKey: "native-lattice-prompt",
          attemptCount: 1,
          time: { created: now },
        }
        await LatticeStore.updateByRunID("home", current.id, (draft) => {
          draft.effect = effect
          draft.pathway = [
            {
              id: Identifier.ascending("lattice_step"),
              title: "Recorded step",
              objective: "Keep this immutable evidence",
              status: "pending",
              acceptanceCriteria: ["Retained"],
              assumptions: [],
              blueprint: {
                noteID: document.id,
                boundVersion: document.version,
                contentDigest: "original-digest",
                time: { bound: now },
              },
              blueprintHistory: [],
              loopHistory: [],
              time: { created: now, updated: now },
            },
          ]
        })
        await Session.update(session.id, (draft) => {
          draft.workflow = { kind: "lattice", runID: current.id, mode: current.mode }
        })
        LatticeModelCalls.record(session.id)
        LatticeModelCalls.record(session.id)
        await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
        const binding = {
          sessionID: session.id,
          scopeID: "home",
          handoffID: "lattice",
          sourceID: "A",
          targetID: "B",
          fromEpoch: 1,
          toEpoch: 2,
        }
        const context = {
          session: await Session.get(session.id),
          rootSessionID: session.id,
          handoffID: binding.handoffID,
          signal: new AbortController().signal,
        }
        expect(await Owners.selected(context)).toContain("lattice")
        await Epochs.beginSource(binding)
        await NoteStore.update("home", document.id, { title: "Later document" })
        await Owners.freeze(context, ["lattice"])
        await Epochs.freeze(binding)
        await expect(
          LatticeStore.updateByRunID("home", current.id, (draft) => {
            draft.modelCallCount++
          }),
        ).rejects.toThrow("transfer")
        const records: Array<{ key: unknown; value: Record<string, unknown> }> = []
        for await (const entry of Owners.entries(context, ["lattice"])) {
          let text = ""
          for await (const bytes of entry.content) text += new TextDecoder().decode(bytes)
          records.push({ key: entry.metadata.key, value: JSON.parse(text) })
        }
        expect(records.some((record) => record.value.id === old.id && record.value.status === "completed")).toBe(true)
        const preserved = records.find((record) => record.value.id === current.id)!.value
        expect(preserved.modelCallCount).toBe(2)
        expect(preserved.effect).toEqual(effect)
        expect(
          records.some(
            (record) =>
              record.value.id === document.id &&
              record.value.version === document.version &&
              record.value.title === document.title,
          ),
        ).toBe(true)
        expect(LatticeModelCalls.peek(session.id)).toBe(0)
      },
    }),
  )
}, 20000)

test("an unsupported retained Lattice schema blocks Continue and handoff preflight without discarding its bytes", async () => {
  const { Storage } = await import("@ericsanchezok/synergy-harness/storage/storage")
  const { SessionExecutionOwners } = await import("@ericsanchezok/synergy-harness/session/execution-owners")
  const { migrations } = await import("../src/lattice/migration")
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null })
        const runID = Identifier.ascending("lattice_run")
        const raw = {
          schemaVersion: 99,
          id: runID,
          scopeID: "home",
          sessionID: session.id,
          future: { pending: ["Do not infer this effect"] },
        }
        const key = ["lattice", "runs", "home", runID]
        await Storage.write(key, raw)
        await Session.update(session.id, (draft) => {
          draft.workflow = { kind: "lattice", runID, mode: "auto" }
        })
        await migrations.find((entry) => entry.id === "20261111-lattice-retained-legacy-archive-v1")!.up(() => {})
        const current = await Session.get(session.id)
        expect(await Storage.read(key)).toEqual(raw)
        await expect(SessionExecutionOwners.assertResume(current)).rejects.toThrow("component")
        const inspected = await Owners.inspect(
          { session: current, rootSessionID: session.id, handoffID: "unknown", signal: new AbortController().signal },
          ["lattice"],
        )
        expect(inspected.requirements).toContainEqual(
          expect.objectContaining({ code: "lattice_schema_unavailable", recoverable: true }),
        )
        expect(await Storage.read(key)).toEqual(raw)
      },
    }),
  )
}, 20000)

test("a cold Runtime retains an unsupported native Lattice ledger and refuses to resume it", async () => {
  const { Storage } = await import("@ericsanchezok/synergy-harness/storage/storage")
  const { SessionExecutionOwners } = await import("@ericsanchezok/synergy-harness/session/execution-owners")
  const { tmpdir } = await import("@ericsanchezok/synergy-harness/test/support/fixture")
  await using directory = await tmpdir()
  await using warm = await testRuntime(undefined, undefined, directory.path)
  const original = await warm.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null })
        const runID = Identifier.ascending("lattice_run")
        const key = ["lattice", "runs", "home", runID]
        const value = {
          schemaVersion: 99,
          id: runID,
          scopeID: "home",
          sessionID: session.id,
          future: { retain: "Cold owner evidence" },
        }
        await Storage.write(key, value)
        await Session.update(session.id, (draft) => {
          draft.workflow = { kind: "lattice", runID, mode: "auto" }
        })
        await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
        return { key, value, sessionID: session.id }
      },
    }),
  )
  await warm.close()
  await using cold = await testRuntime(undefined, undefined, directory.path)
  await cold.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.get(original.sessionID)
        expect(await Storage.read(original.key)).toEqual(original.value)
        expect(session.workflow).toMatchObject({ kind: "lattice", runID: original.value.id })
        await expect(SessionExecutionOwners.assertResume(session)).rejects.toThrow("component")
        expect(session.paused).toBeDefined()
      },
    }),
  )
}, 20000)

test("native Lattice history and its exact documents cross private staging without executing a pending effect", async () => {
  const {
    SessionTransferCore: Core,
    SessionTransferStream: Stream,
    SessionTransferStaging: Staging,
  } = await import("@ericsanchezok/synergy-harness/session/transfer")
  const { Storage } = await import("@ericsanchezok/synergy-harness/storage/storage")
  const { NoteVersions } = await import("@ericsanchezok/synergy-note")
  const { migrations } = await import("../src/lattice/migration")
  const { LatticeLegacyArchive } = await import("../src/lattice/legacy-archive")
  const { BlueprintLoopStore } = await import("@ericsanchezok/synergy-blueprint/blueprint/loop-store")
  const { BlueprintLoopService } = await import("@ericsanchezok/synergy-blueprint/blueprint/service")
  const { tmpdir } = await import("@ericsanchezok/synergy-harness/test/support/fixture")
  const path = await import("node:path")
  await using directory = await tmpdir()
  const store = {
    async put(hash: string, bytes: Uint8Array) {
      await Bun.write(path.join(directory.path, hash), bytes)
    },
    async get(hash: string, maximum: number) {
      const file = Bun.file(path.join(directory.path, hash))
      if (file.size > maximum) throw new Error("Oversized fixture object")
      return new Uint8Array(await file.arrayBuffer())
    },
  }
  await using source = await testRuntime(undefined, Core.register)
  const data = await source.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null, environmentID: null })
        const old = await LatticeStore.create({ sessionID: session.id, mode: "auto" })
        await LatticeStore.updateByRunID("home", old.id, (draft) => {
          draft.status = "completed"
          draft.time.completed = Date.now()
        })
        const current = await LatticeStore.create({ sessionID: session.id, mode: "collaborative" })
        const note = await NoteStore.create({ title: "Reviewed original", kind: "blueprint" })
        await LatticeStore.updateByRunID("home", current.id, (draft) => {
          draft.effect = {
            id: Identifier.ascending("lattice_effect"),
            kind: "deliver_prompt",
            promptType: "state_entry",
            state: "clarifying",
            deliveryKey: "retained-unexecuted",
            attemptCount: 2,
            time: { created: Date.now() },
          }
          draft.pathway = [
            {
              id: Identifier.ascending("lattice_step"),
              title: "Retain native evidence",
              objective: "Original",
              status: "pending",
              acceptanceCriteria: ["Stable"],
              assumptions: [],
              blueprint: {
                noteID: note.id,
                boundVersion: note.version,
                reviewedVersion: note.version,
                contentDigest: "original",
                time: { bound: Date.now() },
              },
              blueprintHistory: [],
              loopHistory: [],
              time: { created: Date.now(), updated: Date.now() },
            },
          ]
        })
        await Session.update(session.id, (draft) => {
          draft.workflow = { kind: "lattice", runID: current.id, mode: current.mode }
        })
        const loop = await BlueprintLoopStore.create({
          sessionID: session.id,
          noteID: note.id,
          noteVersion: note.version,
          title: note.title,
          source: "lattice",
        })
        await BlueprintLoopService.bindSessionToLoop(session.id, loop.id, "execution")
        await BlueprintLoopStore.updateStatus("home", loop.id, { status: "running" })
        await LatticeStore.updateByRunID("home", current.id, (draft) => {
          draft.pathway[0].loopHistory.push({
            loopID: loop.id,
            status: "running",
            sourceDigest: "original",
            time: { created: Date.now() },
          })
        })
        await Storage.write(["lattice", "runs", "home", session.id], {
          schemaVersion: 1,
          id: Identifier.ascending("lattice_run"),
          sessionID: session.id,
          scopeID: "home",
          future: { original: ["Opaque legacy history"] },
        })
        await Storage.write(["lattice", "events", "home", session.id, "original-legacy-event"], {
          original: { bytes: "Legacy native audit" },
        })
        await migrations.find((entry) => entry.id === "20261111-lattice-retained-legacy-archive-v1")!.up(() => {})
        await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
        const binding = {
          sessionID: session.id,
          scopeID: "home",
          handoffID: "lattice-roundtrip",
          sourceID: "A",
          targetID: "B",
          fromEpoch: 1,
          toEpoch: 2,
        }
        await Epochs.beginSource(binding)
        await NoteStore.update("home", note.id, { title: "Current authoring revision" })
        const event = await LatticeStore.appendEvent("home", current, {
          kind: "run_updated",
          message: "Original ledger event",
          data: { future: { retained: true } },
        })
        const context = {
          session: await Session.get(session.id),
          rootSessionID: session.id,
          handoffID: binding.handoffID,
          signal: new AbortController().signal,
        }
        const owners = await Owners.selected(context)
        expect(owners).toContain("blueprint")
        await Owners.freeze(context, owners)
        await Epochs.freeze(binding)
        const exported = await Stream.write({
          store,
          owners: Owners.versions(owners),
          entries: Owners.entries(context, owners),
        })
        const archive = []
        for await (const entry of LatticeLegacyArchive.records("home", session.id)) archive.push(entry)
        return {
          binding,
          session: await Session.get(session.id),
          owners,
          exported,
          archive,
          old: await LatticeStore.getByRunID("home", old.id),
          raw: await Storage.read(["lattice", "runs", "home", current.id]),
          event: await Storage.read(["lattice", "events", "home", current.id, event.id]),
          eventID: event.id,
          runID: current.id,
          note,
          currentNote: await NoteStore.snapshotForTransfer("home", note.id),
        }
      },
    }),
  )
  await using target = await testRuntime(undefined, Core.register)
  await target.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const received = await Staging.receive({ handoffID: data.binding.handoffID, root: data.exported, store })
        const contexts: Array<{ ownerID: string; context: Owners.TargetContext }> = []
        for (const ownerID of data.owners) {
          const context = await Staging.context({
            handoffID: data.binding.handoffID,
            ownerID,
            session: data.session,
            rootSessionID: data.session.id,
            mapping: {},
            signal: new AbortController().signal,
          })
          await Owners.validate(ownerID, context)
          contexts.push({ ownerID, context })
        }
        await expect(Session.get(data.session.id)).rejects.toThrow()
        await Epochs.reserve(data.binding, received.rootHash)
        await Epochs.activate(data.binding, received.rootHash, () =>
          Staging.publish({ handoffID: data.binding.handoffID, contexts }),
        )
        expect(await Storage.read(["lattice", "runs", "home", data.runID])).toEqual(data.raw)
        expect(await Storage.read(["lattice", "events", "home", data.runID, data.eventID])).toEqual(data.event)
        expect(await LatticeStore.getByRunID("home", data.old!.id)).toEqual(data.old)
        expect(await LatticeStore.get("home", data.session.id)).toMatchObject({
          effect: { deliveryKey: "retained-unexecuted", attemptCount: 2 },
        })
        expect(await NoteVersions.read("home", data.note.id, data.note.version)).toMatchObject({
          title: data.note.title,
        })
        expect(await NoteStore.snapshotForTransfer("home", data.note.id)).toEqual(data.currentNote)
        expect((await Session.get(data.session.id)).paused).toBeDefined()
        expect(await Session.messages({ sessionID: data.session.id })).toEqual([])
        for (const original of data.archive) expect(await Storage.read(original.key)).toEqual(original.value)
      },
    }),
  )
}, 30000)

test("a refused native counter flush retains pending model evidence for reconciliation", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null })
        await LatticeStore.create({ sessionID: session.id, mode: "auto" })
        LatticeModelCalls.record(session.id)
        LatticeModelCalls.record(session.id)
        await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
        const binding = {
          sessionID: session.id,
          scopeID: "home",
          handoffID: "counter",
          sourceID: "A",
          targetID: "B",
          fromEpoch: 1,
          toEpoch: 2,
        }
        await Epochs.freeze(binding)
        await expect(LatticeModelCalls.flush("home", session.id)).rejects.toThrow("transfer")
        expect(LatticeModelCalls.peek(session.id)).toBe(2)
        await Epochs.cancel(binding)
        expect(await LatticeModelCalls.flush("home", session.id)).toBe(2)
        expect(LatticeModelCalls.peek(session.id)).toBe(0)
      },
    }),
  )
}, 20000)

test("concurrent native counter flushes acknowledge the same persisted total", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null })
        await LatticeStore.create({ sessionID: session.id, mode: "auto" })
        LatticeModelCalls.record(session.id)
        LatticeModelCalls.record(session.id)
        expect(
          await Promise.all([LatticeModelCalls.flush("home", session.id), LatticeModelCalls.flush("home", session.id)]),
        ).toEqual([2, 2])
        expect((await LatticeStore.get("home", session.id)).modelCallCount).toBe(2)
      },
    }),
  )
}, 20000)

test("a lost model-counter acknowledgement reuses its native commit receipt without counting twice", async () => {
  const { spyOn } = await import("bun:test")
  const { Storage } = await import("@ericsanchezok/synergy-harness/storage/storage")
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null })
        await LatticeStore.create({ sessionID: session.id, mode: "auto" })
        LatticeModelCalls.record(session.id)
        LatticeModelCalls.record(session.id)
        const original = Storage.transaction
        let dropped = false
        const acknowledgement = spyOn(Storage, "transaction").mockImplementation(
          async <T>(
            body: Parameters<typeof Storage.transaction<T>>[0],
            options?: Parameters<typeof Storage.transaction<T>>[1],
          ): Promise<T> => {
            const result = await original(body, options)
            if (!dropped && options?.operationID?.startsWith("lattice-model-calls:")) {
              dropped = true
              throw new Error("Synthetic committed acknowledgement lost")
            }
            return result
          },
        )
        try {
          await expect(LatticeModelCalls.flush("home", session.id)).rejects.toThrow("acknowledgement lost")
          expect((await LatticeStore.get("home", session.id)).modelCallCount).toBe(2)
          expect(LatticeModelCalls.peek(session.id)).toBe(2)
          LatticeModelCalls.record(session.id)
          expect(await LatticeModelCalls.flush("home", session.id)).toBe(2)
          expect(LatticeModelCalls.peek(session.id)).toBe(1)
          expect(await LatticeModelCalls.flush("home", session.id)).toBe(3)
          expect((await LatticeStore.get("home", session.id)).modelCallCount).toBe(3)
          expect(LatticeModelCalls.peek(session.id)).toBe(0)
        } finally {
          acknowledgement.mockRestore()
        }
      },
    }),
  )
}, 20000)
