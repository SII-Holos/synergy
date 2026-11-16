import { expect, test } from "bun:test"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import {
  SessionTransferOwners as Owners,
  SessionTransferEpochs as Epochs,
} from "@ericsanchezok/synergy-harness/session/transfer"
import { LightLoopRuntime } from "../src/light-loop/runtime"
import { LightLoopTerminalStore } from "../src/light-loop/terminal-hook"
import { testRuntime } from "./support/runtime"

test("Light Loop transfer stops terminal effects while preserving native workflow and deadline", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null })
        const workflow = {
          kind: "lightloop" as const,
          instructions: "Preserve the full goal",
          deadlineAt: Date.now() + 100000,
        }
        await Session.update(session.id, (draft) => {
          draft.workflow = workflow
        })
        await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
        const context = {
          session: await Session.get(session.id),
          rootSessionID: session.id,
          handoffID: "light",
          signal: new AbortController().signal,
        }
        expect(await Owners.selected(context)).toContain("light-loop")
        const binding = {
          sessionID: session.id,
          scopeID: "home",
          handoffID: "light",
          sourceID: "A",
          targetID: "B",
          fromEpoch: 1,
          toEpoch: 2,
        }
        await Epochs.beginSource(binding)
        await Owners.freeze(context, ["light-loop"])
        await expect(LightLoopRuntime.setTerminalStatus(session.id, "cancelled")).rejects.toThrow("transfer")
        expect((await Session.get(session.id)).workflow).toEqual(workflow)
        expect(await LightLoopTerminalStore.get(session)).toBeUndefined()
        await Epochs.freeze(binding)
        const entries = []
        for await (const entry of Owners.entries(context, ["light-loop"])) {
          let text = ""
          for await (const bytes of entry.content) text += new TextDecoder().decode(bytes)
          entries.push({ key: entry.metadata.key, value: JSON.parse(text) })
        }
        expect(entries).toHaveLength(1)
        expect(entries[0].value.workflow).toEqual(workflow)
      },
    }),
  )
})

test("Light Loop terminal history crosses verified private staging with its delivery acknowledgement intact", async () => {
  const { SessionTransferStream: Stream, SessionTransferStaging: Staging } =
    await import("@ericsanchezok/synergy-harness/session/transfer")
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
  await using source = await testRuntime()
  const sourceData = await source.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const initial = await Session.create({ workspace: null })
        await Session.update(initial.id, (draft) => {
          draft.workflow = { kind: "lightloop", instructions: "Retain completed goal" }
        })
        await LightLoopRuntime.setTerminalStatus(initial.id, "completed")
        await SessionLifecycle.pause({ sessionID: initial.id, reason: "interrupted" })
        const session = await Session.get(initial.id)
        const binding = {
          sessionID: session.id,
          scopeID: "home",
          handoffID: "terminal",
          sourceID: "A",
          targetID: "B",
          fromEpoch: 1,
          toEpoch: 2,
        }
        const context = {
          session,
          rootSessionID: session.id,
          handoffID: binding.handoffID,
          signal: new AbortController().signal,
        }
        expect(await Owners.selected(context)).toContain("light-loop")
        await Epochs.beginSource(binding)
        await Owners.freeze(context, ["light-loop"])
        await Epochs.freeze(binding)
        const root = await Stream.write({
          store,
          owners: { "light-loop": 1 },
          entries: Owners.entries(context, ["light-loop"]),
        })
        return { session, binding, root, terminal: await LightLoopTerminalStore.get(session) }
      },
    }),
  )
  await using target = await testRuntime()
  await target.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const staged = await Staging.receive({ handoffID: "terminal", root: sourceData.root, store })
        const context = await Staging.context({
          handoffID: "terminal",
          ownerID: "light-loop",
          session: sourceData.session,
          rootSessionID: sourceData.session.id,
          mapping: {},
          signal: new AbortController().signal,
        })
        await Owners.validate("light-loop", context)
        await expect(Session.get(sourceData.session.id)).rejects.toThrow()
        await Epochs.reserve(sourceData.binding, staged.rootHash)
        await Epochs.activate(sourceData.binding, staged.rootHash, async () => {
          await Session.create({ id: sourceData.session.id, workspace: null })
          await SessionLifecycle.pause({ sessionID: sourceData.session.id, reason: "interrupted" })
          await Staging.publish({ handoffID: "terminal", contexts: [{ ownerID: "light-loop", context }] })
        })
        expect(await LightLoopTerminalStore.get(sourceData.session)).toEqual(sourceData.terminal)
        expect(sourceData.terminal?.hookDeliveredAt).toBeNumber()
        expect((await Session.get(sourceData.session.id)).workflow).toBeUndefined()
      },
    }),
  )
})

test("a cancelled Light Loop handoff restores its original absolute deadline only after independent Continue", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null })
        const deadlineAt = Date.now() + 300
        await Session.update(session.id, (draft) => {
          draft.workflow = { kind: "lightloop", instructions: "Keep the original deadline", deadlineAt }
        })
        LightLoopRuntime.scheduleDeadline(session.id, deadlineAt)
        await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
        const binding = {
          sessionID: session.id,
          scopeID: "home",
          handoffID: "deadline",
          sourceID: "A",
          targetID: "B",
          fromEpoch: 1,
          toEpoch: 2,
        }
        const context = {
          session: await Session.get(session.id),
          rootSessionID: session.id,
          handoffID: "deadline",
          signal: new AbortController().signal,
        }
        await Epochs.beginSource(binding)
        await Owners.freeze(context, ["light-loop"])
        await Epochs.freeze(binding)
        await Bun.sleep(350)
        expect((await Session.get(session.id)).workflow?.kind).toBe("lightloop")
        await Epochs.cancel(binding)
        await expect(
          Owners.resume({
            session: await Session.get(session.id),
            rootSessionID: session.id,
            intentID: "deadline-continue",
            signal: new AbortController().signal,
          }),
        ).rejects.toThrow("Continue")
        await SessionLifecycle.clear(session.id)
        await Owners.resume({
          session: await Session.get(session.id),
          rootSessionID: session.id,
          intentID: "deadline-continue",
          signal: new AbortController().signal,
        })
        const until = Date.now() + 2000
        while (!(await LightLoopTerminalStore.get(session))) {
          if (Date.now() > until) throw new Error("Original deadline did not settle")
          await Bun.sleep(5)
        }
        expect((await LightLoopTerminalStore.get(session))?.status).toBe("timed_out")
      },
    }),
  )
})
