import { expect, test } from "bun:test"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import {
  SessionTransferOwners as Owners,
  SessionTransferEpochs as Epochs,
} from "@ericsanchezok/synergy-harness/session/transfer"
import { NoteStore } from "@ericsanchezok/synergy-note"
import { BlueprintLoopStore } from "../src/blueprint/loop-store"
import { BlueprintLoopService } from "../src/blueprint/service"
import { SuperPlanStore } from "../src/superplan/store"
import { testRuntime } from "./support/runtime"

test("Blueprint portability preserves exact authoring versions, audit children and native SuperPlan events", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const execution = await Session.create({ workspace: null })
        const audit = await Session.create({ parentID: execution.id, workspace: null })
        const document = await NoteStore.create({ title: "Audited document", kind: "blueprint" })
        const loop = await BlueprintLoopStore.create({
          noteID: document.id,
          noteVersion: document.version,
          title: document.title,
          sessionID: execution.id,
        })
        await BlueprintLoopStore.updateStatus("home", loop.id, { status: "running" })
        await BlueprintLoopStore.updateStatus("home", loop.id, {
          status: "auditing",
          auditSessionID: audit.id,
          auditTaskID: "task_native_audit",
          audit: { attempts: 2 },
        })
        await NoteStore.update("home", document.id, { title: "A later document revision" })
        const plan = await SuperPlanStore.create({
          title: "Native graph",
          plannerSessionID: execution.id,
          nodes: [{ title: "Original node", blueprintNoteID: document.id }],
        })
        await SuperPlanStore.appendEvent("home", plan.id, {
          kind: "node_started",
          nodeID: plan.nodes[0].id,
          message: "Preserve original event",
        })
        await Session.update(execution.id, (draft) => {
          draft.workflow = { kind: "plan" }
          draft.superplan = { runID: plan.id, role: "planner" }
        })
        await SessionLifecycle.pause({ sessionID: execution.id, reason: "interrupted" })
        const context = {
          session: await Session.get(execution.id),
          rootSessionID: execution.id,
          handoffID: "blueprint",
          signal: new AbortController().signal,
        }
        expect(await Owners.selected(context)).toContain("blueprint")
        const inspected = await Owners.inspect(context, ["blueprint"])
        expect(inspected.requirements).toEqual([])
        const children = []
        for await (const child of inspected.children) children.push(child)
        expect(children).toContain(audit.id)
        const binding = {
          sessionID: execution.id,
          scopeID: "home",
          handoffID: "blueprint",
          sourceID: "A",
          targetID: "B",
          fromEpoch: 1,
          toEpoch: 2,
        }
        await Epochs.beginSource(binding)
        await Owners.freeze(context, ["blueprint"])
        await Epochs.freeze(binding)
        await expect(BlueprintLoopStore.updateStatus("home", loop.id, { status: "running" })).rejects.toThrow(
          "transfer",
        )
        await expect(SuperPlanStore.appendEvent("home", plan.id, { kind: "run_updated" })).rejects.toThrow("transfer")
        const records: Array<{ key: unknown; value: Record<string, unknown> }> = []
        for await (const entry of Owners.entries(context, ["blueprint"])) {
          let text = ""
          for await (const bytes of entry.content) text += new TextDecoder().decode(bytes)
          records.push({ key: entry.metadata.key, value: JSON.parse(text) })
        }
        expect(records.some((record) => record.value.id === loop.id && record.value.status === "auditing")).toBe(true)
        expect(
          records.some(
            (record) =>
              record.value.id === document.id &&
              record.value.version === document.version &&
              record.value.title === document.title,
          ),
        ).toBe(true)
        expect(
          records.some(
            (record) => record.value.kind === "node_started" && record.value.message === "Preserve original event",
          ),
        ).toBe(true)
      },
    }),
  )
}, 20000)

test("Note transfer retains unknown nested owner metadata in current and exact historical versions", async () => {
  const { NoteVersions } = await import("@ericsanchezok/synergy-note")
  const { Storage } = await import("@ericsanchezok/synergy-harness/storage/storage")
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const note = await NoteStore.create({ title: "Nested canonical metadata", kind: "blueprint" })
        await NoteStore.mutateMetadata("home", note.id, (draft) => {
          const metadata = draft.blueprint as Record<string, unknown>
          metadata.futureOwner = { retained: { value: "Original nested bytes" } }
        })
        const stored = await Storage.read<Awaited<ReturnType<typeof NoteStore.snapshotForTransfer>>>([
          "notes",
          "home",
          note.id,
        ])
        expect(await NoteStore.snapshotForTransfer("home", note.id)).toEqual(stored)
        expect(await NoteVersions.read("home", note.id, 2)).toEqual(stored)
      },
    }),
  )
}, 20000)

test("native Blueprint, Cortex audit and exact Note versions activate together from verified private staging", async () => {
  const {
    SessionTransferCore: Core,
    SessionTransferStream: Stream,
    SessionTransferStaging: Staging,
  } = await import("@ericsanchezok/synergy-harness/session/transfer")
  const { Cortex } = await import("@ericsanchezok/synergy-harness/cortex")
  const { Identifier } = await import("@ericsanchezok/synergy-harness/id/id")
  const { NoteVersions } = await import("@ericsanchezok/synergy-note")
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
        const root = await Session.create({ workspace: null, environmentID: null })
        const messageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: messageID,
          sessionID: root.id,
          role: "user",
          isRoot: true,
          rootID: messageID,
          agent: "general",
          model: { providerID: "fixture", modelID: "fixture" },
          time: { created: Date.now() },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: root.id,
          messageID,
          type: "text",
          text: "Recorded work requiring native review",
        })
        const audit = await Cortex.prepare({
          parentSessionID: root.id,
          parentMessageID: messageID,
          agent: "supervisor",
          description: "Recorded audit",
          prompt: "Audit the original Blueprint",
          executionRole: "primary",
          visibility: "hidden",
          notifyParentOnComplete: false,
          output: { mode: "structured", schema: { type: "object" } },
        })
        const note = await NoteStore.create({ title: "Original review document", kind: "blueprint" })
        await NoteStore.mutateMetadata("home", note.id, (draft) => {
          ;(draft.blueprint as Record<string, unknown>).futureOwner = { stable: [1, "keep nested bytes"] }
        })
        const original = await NoteStore.snapshotForTransfer("home", note.id)
        const loop = await BlueprintLoopStore.create({
          noteID: note.id,
          noteVersion: original.version,
          sessionID: root.id,
          title: note.title,
          auditAgent: "supervisor",
        })
        await BlueprintLoopService.bindSessionToLoop(root.id, loop.id, "execution")
        await BlueprintLoopService.bindSessionToLoop(audit.sessionID, loop.id, "audit")
        await BlueprintLoopStore.updateStatus("home", loop.id, { status: "running" })
        await BlueprintLoopStore.updateStatus("home", loop.id, {
          status: "auditing",
          auditSessionID: audit.sessionID,
          auditTaskID: audit.id,
          audit: { attempts: 3 },
        })
        await NoteStore.update("home", note.id, { title: "Later authoring title" })
        await SessionLifecycle.pause({ sessionID: root.id, reason: "interrupted" })
        const base = {
          scopeID: "home",
          handoffID: "native-blueprint",
          sourceID: "A",
          targetID: "B",
          fromEpoch: 1,
          toEpoch: 2,
        }
        const bindings = [
          { ...base, sessionID: root.id },
          { ...base, sessionID: audit.sessionID, rootSessionID: root.id },
        ]
        const members = []
        for (const binding of bindings) {
          await Epochs.beginSource(binding)
          const context = {
            session: await Session.get(binding.sessionID),
            rootSessionID: root.id,
            handoffID: base.handoffID,
            signal: new AbortController().signal,
          }
          members.push({ context, owners: await Owners.selected(context), binding })
        }
        const receipts = []
        for (const member of members) receipts.push(await Owners.freeze(member.context, member.owners))
        for (const [index, member] of members.entries())
          await Epochs.freeze(member.binding, index ? { owner: receipts[index] } : {})
        const ownerIDs = [...new Set(members.flatMap((member) => member.owners))]
        const exported = await Stream.write({
          store,
          owners: Owners.versions(ownerIDs),
          entries: (async function* () {
            for (const member of members) yield* Owners.entries(member.context, member.owners)
          })(),
        })
        return {
          rootID: root.id,
          bindings,
          members: await Promise.all(
            members.map(async (member) => ({
              session: await Session.get(member.binding.sessionID),
              owners: member.owners,
            })),
          ),
          exported,
          loop: await BlueprintLoopStore.getStored("home", loop.id),
          original,
          current: await NoteStore.snapshotForTransfer("home", note.id),
          audit,
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
        const received = await Staging.receive({ handoffID: "native-blueprint", root: data.exported, store })
        const contexts: Array<{ ownerID: string; context: Owners.TargetContext }> = []
        for (const member of data.members)
          for (const ownerID of member.owners) {
            const context = await Staging.context({
              handoffID: "native-blueprint",
              ownerID,
              session: member.session,
              rootSessionID: data.rootID,
              mapping: {},
              signal: new AbortController().signal,
            })
            await Owners.validate(ownerID, context)
            contexts.push({ ownerID, context })
          }
        await expect(Session.get(data.rootID)).rejects.toThrow()
        await expect(NoteStore.get("home", data.original.id)).rejects.toThrow()
        for (const binding of data.bindings) await Epochs.reserve(binding, received.rootHash)
        await Epochs.activateMany({
          bindings: data.bindings,
          manifestHash: received.rootHash,
          publish: () => Staging.publish({ handoffID: "native-blueprint", contexts }),
        })
        expect(await BlueprintLoopStore.getStored("home", data.loop.id)).toEqual(data.loop)
        expect(await NoteStore.snapshotForTransfer("home", data.original.id)).toEqual(data.current)
        expect(await NoteVersions.read("home", data.original.id, data.original.version)).toEqual(data.original)
        const audit = await Session.get(data.audit.sessionID)
        expect(audit.cortex).toMatchObject({
          taskID: data.audit.id,
          status: "queued",
          parentSessionID: data.rootID,
          transfer: { handoffID: "native-blueprint", admitted: false },
        })
        expect(audit.paused).toBeUndefined()
        expect(audit.blueprint).toMatchObject({ loopID: data.loop.id, loopRole: "audit", phase: "auditing" })
        expect((await Session.get(data.rootID)).blueprint).toMatchObject({
          loopID: data.loop.id,
          loopRole: "execution",
          phase: "auditing",
        })
        expect(await Epochs.isFrozen(audit.id)).toBe(true)
        expect((await Session.get(data.rootID)).paused).toBeDefined()
        expect(
          (await Session.messages({ sessionID: data.rootID })).some(
            (message) => message.info.id === data.audit.parentMessageID,
          ),
        ).toBe(true)
      },
    }),
  )
}, 30000)
