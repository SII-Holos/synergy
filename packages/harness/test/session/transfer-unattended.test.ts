import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { Session } from "../../src/session"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { SessionInteraction } from "../../src/session/interaction"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { SessionTransferEpochs as Epochs } from "../../src/session/transfer-epochs"
import { SessionTransferOwners as Owners } from "../../src/session/transfer-owners"
import { SessionTransferGate as Gate } from "../../src/session/transfer-gate"

function register() {
  Owners.register("machine-fixture", {
    version: 1,
    reads: [1],
    applies: (session) => SessionInteraction.isUnattended(session.interaction),
    async inspect() {
      return { requirements: [], children: (async function* () {})() }
    },
    async freeze(context) {
      await Session.update(context.session.id, (draft) => {
        draft.title = "owner drained"
      })
      if (context.handoffID === "prepare-failure") throw new Error("owner preparation interrupted")
    },
    async *export() {},
    async validate() {},
    async publish() {},
  })
  Owners.register("session-core", {
    version: 1,
    reads: [1],
    applies: () => true,
    async inspect() {
      return { requirements: [], children: (async function* () {})() }
    },
    async freeze() {},
    async *export() {},
    async validate() {},
    async publish() {},
  })
}

test("owned child transfer freezes machine scheduling without forging a human pause and holds target children until root Continue", async () => {
  await using source = await testRuntime({ register })
  const aggregate = await source.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = await Session.create({ workspace: null })
        const child = await Session.create({
          parentID: root.id,
          workspace: null,
          interaction: SessionInteraction.unattended("machine-fixture"),
        })
        expect(await Epochs.ownerResumeBinding({ sessionID: child.id, rootSessionID: root.id })).toBeUndefined()
        await SessionLifecycle.pause({ sessionID: root.id, reason: "interrupted" })
        expect(await SessionLifecycle.pause({ sessionID: child.id, reason: "interrupted" })).toBe(false)
        const rootBinding = {
          sessionID: root.id,
          scopeID: "home",
          handoffID: "owned",
          sourceID: "A",
          targetID: "B",
          fromEpoch: 1,
          toEpoch: 2,
        }
        const childBinding = { ...rootBinding, sessionID: child.id, rootSessionID: root.id }
        await Epochs.freeze(rootBinding)
        await expect(Epochs.freeze(childBinding)).rejects.toThrow("paused")
        const receipt = await Owners.freeze(
          { session: child, rootSessionID: root.id, handoffID: "owned", signal: new AbortController().signal },
          ["machine-fixture"],
        )
        await Epochs.freeze(childBinding, { owner: receipt })
        expect((await Session.get(child.id)).paused).toBeUndefined()
        await expect(Gate.assert(child.id)).rejects.toThrow("transfer")
        await Epochs.seal(rootBinding, "a".repeat(64))
        await Epochs.surrender(rootBinding, "b".repeat(64))
        await Epochs.seal(childBinding, "a".repeat(64))
        await Epochs.surrender(childBinding, "b".repeat(64))
        return { root, child, rootBinding, childBinding }
      },
    }),
  )
  await using target = await testRuntime({ register })
  await target.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        await Epochs.reserve(aggregate.rootBinding, "a".repeat(64))
        await Epochs.reserve(aggregate.childBinding, "a".repeat(64))
        await Epochs.activate(aggregate.rootBinding, "a".repeat(64), async () => {
          await Session.create({ id: aggregate.root.id, workspace: null })
          await SessionLifecycle.pause({ sessionID: aggregate.root.id, reason: "interrupted" })
        })
        const unrelated = await Session.create({ workspace: null })
        await expect(
          Epochs.activate(aggregate.childBinding, "a".repeat(64), async () => {
            await Session.create({
              id: aggregate.child.id,
              parentID: unrelated.id,
              workspace: null,
              interaction: aggregate.child.interaction,
            })
          }),
        ).rejects.toThrow("aggregate root")
        await expect(Session.get(aggregate.child.id)).rejects.toThrow()
        await Epochs.activate(aggregate.childBinding, "a".repeat(64), async () => {
          await Session.create({
            id: aggregate.child.id,
            parentID: aggregate.root.id,
            workspace: null,
            interaction: aggregate.child.interaction,
          })
        })
        expect((await Session.get(aggregate.child.id)).paused).toBeUndefined()
        expect(await Epochs.isFrozen(aggregate.child.id)).toBe(true)
        await expect(Gate.assert(aggregate.child.id)).rejects.toThrow("transfer")
        const resume = { sessionID: aggregate.child.id, rootSessionID: aggregate.root.id, handoffID: "owned" }
        await expect(Epochs.assertOwnerResume(resume)).rejects.toThrow("resume")
        await expect(Epochs.ownerResumeBinding(resume)).rejects.toThrow("resume")
        await SessionLifecycle.clear(aggregate.root.id)
        expect(await Epochs.isFrozen(aggregate.child.id)).toBe(false)
        await expect(Gate.assert(aggregate.child.id)).resolves.toBeUndefined()
        await expect(Epochs.assertOwnerResume(resume)).resolves.toBeUndefined()
        expect(await Epochs.ownerResumeBinding(resume)).toEqual(aggregate.childBinding)
        await expect(Epochs.assertOwnerResume({ ...resume, handoffID: "forged" })).rejects.toThrow("resume")
        await SessionLifecycle.pause({ sessionID: aggregate.root.id, reason: "interrupted" })
        const returningRoot = {
          ...aggregate.rootBinding,
          handoffID: "returning",
          sourceID: "B",
          targetID: "A",
          fromEpoch: 2,
          toEpoch: 3,
        }
        const returningChild = { ...returningRoot, sessionID: aggregate.child.id, rootSessionID: aggregate.root.id }
        await Epochs.freeze(returningRoot)
        const receipt = await Owners.freeze(
          {
            session: await Session.get(aggregate.child.id),
            rootSessionID: aggregate.root.id,
            handoffID: "returning",
            signal: new AbortController().signal,
          },
          ["machine-fixture"],
        )
        await Epochs.freeze(returningChild, { owner: receipt })
        await expect(Epochs.assertFrozen(aggregate.child.id, "owned")).rejects.toThrow("exact")
        await expect(Epochs.assertFrozen(aggregate.child.id, "returning")).resolves.toBeUndefined()
        await expect(Epochs.assertOwnerResume(resume)).rejects.toThrow("resume")
        await Epochs.cancel(returningRoot)
        await Epochs.cancel(returningChild)
        await expect(Epochs.assertOwnerResume({ ...resume, handoffID: "returning" })).rejects.toThrow("resume")
        await SessionLifecycle.clear(aggregate.root.id)
        await expect(Epochs.assertOwnerResume({ ...resume, handoffID: "returning" })).resolves.toBeUndefined()
        await expect(Epochs.assertOwnerResume(resume)).rejects.toThrow("resume")
      },
    }),
  )
})

test("an interrupted owner preparation has a durable cancellation proof before final freeze", async () => {
  await using runtime = await testRuntime({ register })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = await Session.create({ workspace: null })
        const child = await Session.create({
          parentID: root.id,
          workspace: null,
          interaction: SessionInteraction.unattended("machine-fixture"),
        })
        await SessionLifecycle.pause({ sessionID: root.id, reason: "interrupted" })
        const binding = {
          sessionID: child.id,
          rootSessionID: root.id,
          scopeID: "home",
          handoffID: "prepare-failure",
          sourceID: "A",
          targetID: "B",
          fromEpoch: 1,
          toEpoch: 2,
        }
        await Epochs.beginSource(binding)
        await expect(
          Owners.freeze(
            {
              session: child,
              rootSessionID: root.id,
              handoffID: binding.handoffID,
              signal: new AbortController().signal,
            },
            ["machine-fixture"],
          ),
        ).rejects.toThrow("interrupted")
        expect((await Epochs.inspect(binding)).phase).toBe("draining")
        expect((await Session.get(child.id)).title).toBe("owner drained")
        await expect(Gate.assert(child.id)).rejects.toThrow("transfer")
        await Epochs.cancel(binding)
        await SessionLifecycle.clear(root.id)
        await expect(
          Epochs.assertOwnerResume({ sessionID: child.id, rootSessionID: root.id, handoffID: binding.handoffID }),
        ).resolves.toBeUndefined()
        await SessionLifecycle.pause({ sessionID: root.id, reason: "interrupted" })
        await Epochs.beginSource({ ...binding, handoffID: "next-attempt", toEpoch: 3 })
        await Epochs.cancel(binding)
        await expect(
          Epochs.assertOwnerResume({ sessionID: child.id, rootSessionID: root.id, handoffID: binding.handoffID }),
        ).rejects.toThrow("resume")
      },
    }),
  )
})

test("archived child history transfers under the root without fabricating a pause or continuation", async () => {
  await using source = await testRuntime({ register })
  const aggregate = await source.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = await Session.create({ workspace: null })
        const child = await Session.create({ parentID: root.id, workspace: null })
        const archived = await Session.update(child.id, (draft) => {
          draft.time.archived = Date.now()
        })
        await SessionLifecycle.pause({ sessionID: root.id, reason: "interrupted" })
        const binding = {
          sessionID: child.id,
          rootSessionID: root.id,
          scopeID: "home",
          handoffID: "archived",
          sourceID: "A",
          targetID: "B",
          fromEpoch: 1,
          toEpoch: 2,
        }
        await Epochs.beginSource(binding)
        const receipt = await Owners.freeze(
          {
            session: archived,
            rootSessionID: root.id,
            handoffID: binding.handoffID,
            signal: new AbortController().signal,
          },
          ["session-core"],
        )
        await Epochs.freeze(binding, { owner: receipt })
        expect((await Session.get(child.id)).paused).toBeUndefined()
        return { root, child: archived, binding }
      },
    }),
  )
  await using target = await testRuntime({ register })
  await target.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = await Session.create({ id: aggregate.root.id, workspace: null })
        await SessionLifecycle.pause({ sessionID: root.id, reason: "interrupted" })
        await Epochs.reserve(aggregate.binding, "a".repeat(64))
        await Epochs.activate(aggregate.binding, "a".repeat(64), async () => {
          await Session.create({ id: aggregate.child.id, parentID: root.id, workspace: null })
          await Session.update(aggregate.child.id, (draft) => {
            draft.time.archived = aggregate.child.time.archived
          })
        })
        expect((await Session.get(aggregate.child.id)).time.archived).toBe(aggregate.child.time.archived)
        expect((await Session.get(aggregate.child.id)).paused).toBeUndefined()
        await SessionLifecycle.clear(root.id)
        await expect(
          Epochs.assertOwnerResume({ sessionID: aggregate.child.id, rootSessionID: root.id, handoffID: "archived" }),
        ).rejects.toThrow("archived")
      },
    }),
  )
})
