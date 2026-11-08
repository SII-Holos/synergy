import { afterAll, expect, test } from "bun:test"
import { PrimaryAgentIdentity } from "../../src/agent/primary-identity"
import { Identifier } from "../../src/id/id"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { InvokeInput } from "../../src/session/input"
import { MessageV2 } from "../../src/session/message-v2"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())
const alice = {
  kind: "account" as const,
  subjectID: "account-a",
  orgID: "org-a",
  displayName: "Alice at submission",
  clientKind: "desktop" as const,
  requestID: "request-a",
}
const bob = { ...alice, subjectID: "account-b", displayName: "Bob", requestID: "request-b" }
const model = { providerID: "actor-fixture", modelID: "actor-fixture" }

test("trusted Inbox attribution survives duplicates, materialization and later collaborator input", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const messageID = Identifier.ascending("message")
        const input = { sessionID: session.id, messageID, model, parts: [{ type: "text" as const, text: "Task" }] }
        const submittedActor = { ...alice }
        const pending = SessionInbox.enqueueUser(input, { actor: submittedActor })
        submittedActor.displayName = "Renamed after submission"
        const item = await pending
        expect(item.message?.actor).toEqual(alice)
        expect((await SessionInbox.enqueueUser(input, { actor: bob })).message?.actor).toEqual(alice)
        expect(await SessionInbox.materializeNextTask(session.id)).toMatchObject({ status: "materialized", messageID })
        expect((await MessageV2.get({ sessionID: session.id, messageID })).info.actor).toEqual(alice)

        const supplement = await SessionInbox.deliverUnique({
          sessionID: session.id,
          deliveryKey: bob.requestID,
          mode: "context",
          message: { role: "user", actor: bob, model, parts: [{ type: "text", text: "A separate author's input" }] },
        })
        const stored = await SessionInbox.getStored(session.id, supplement.itemID)
        expect((await SessionInbox.materializeItem(stored, messageID))?.info.actor).toEqual(bob)

        const assistant = await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "assistant",
          rootID: messageID,
          parentID: supplement.messageID,
          agent: PrimaryAgentIdentity.names.general,
          mode: PrimaryAgentIdentity.names.general,
          path: { cwd: null, root: null },
          time: { created: Date.now() },
          modelID: model.modelID,
          providerID: model.providerID,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })
        expect(assistant.actor).toEqual(alice)
        const changed = await Session.updateMessage({ ...assistant, actor: bob })
        expect(changed.actor).toEqual(alice)
        const original = await MessageV2.get({ sessionID: session.id, messageID })
        expect((await Session.updateMessage({ ...original.info, actor: bob })).actor).toEqual(alice)
        expect(MessageV2.deriveSemantics([original])[0].info.actor).toEqual(alice)

        const retry = await SessionInbox.enqueueUser(input, { actor: bob })
        expect(retry.messageID).toBe(messageID)
        expect(await SessionInbox.list(session.id)).toHaveLength(0)
        expect((await MessageV2.get({ sessionID: session.id, messageID })).info.actor).toEqual(alice)
        const fork = await Session.fork({ sessionID: session.id })
        const copied = await Session.messages({ sessionID: fork.id })
        expect(copied.map((message) => message.info.actor)).toEqual([alice, bob, alice])
        expect(copied.map((message) => message.info.id)).not.toContain(messageID)
      },
    })
  }))

test("attributed pending input survives a Runtime restart with its original author", async () => {
  await using home = await tmpdir()
  let sessionID: string
  let itemID: string
  let messageID: string
  {
    await using source = await testRuntime({ home: home.path })
    await source.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const session = await Session.create({ workspaceID: null })
          sessionID = session.id
          const queued = await SessionInbox.enqueueUser(
            { sessionID, model, parts: [{ type: "text", text: "Persist before restarting" }] },
            { actor: alice },
          )
          itemID = queued.id
          messageID = queued.messageID
        },
      }),
    )
  }
  await using reopened = await testRuntime({ home: home.path })
  await reopened.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        expect((await SessionInbox.get(sessionID, itemID)).message?.actor).toEqual(alice)
        expect(await SessionInbox.materializeNextTask(sessionID)).toMatchObject({ status: "materialized", messageID })
        expect((await MessageV2.get({ sessionID, messageID })).info.actor).toEqual(alice)
      },
    }),
  )
})

test("wire input cannot assign a trusted actor and transactional rollback leaves no attributed input", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const wire = InvokeInput.parse({
          sessionID: session.id,
          model,
          actor: alice,
          parts: [{ type: "text", text: "Hi" }],
        })
        expect(wire).not.toHaveProperty("actor")
        const personal = await SessionInbox.enqueueUser(wire)
        expect(personal.message?.actor).toBeUndefined()
        await SessionInbox.materializeNextTask(session.id)
        const message = await MessageV2.get({ sessionID: session.id, messageID: personal.messageID })
        expect(message.info.actor).toBeUndefined()
        expect((await Session.updateMessage({ ...message.info, actor: alice })).actor).toBeUndefined()

        await expect(
          Storage.transaction(async () => {
            await SessionInbox.enqueueUser({ ...wire, messageID: Identifier.ascending("message") }, { actor: bob })
            throw new Error("Roll back command admission")
          }),
        ).rejects.toThrow("Roll back command admission")
        expect(await SessionInbox.list(session.id)).toHaveLength(0)
      },
    })
  }))
