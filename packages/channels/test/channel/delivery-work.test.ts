import { afterAll, expect, spyOn, test } from "bun:test"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Asset } from "@ericsanchezok/synergy-harness/asset/asset"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionHistory } from "@ericsanchezok/synergy-harness/session/history"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { collectChannelTerminalInfos, loadChannelDeliveryPlans } from "../../src/channel/delivery-plan"
import { executeChannelDeliveryPlan } from "../../src/channel/delivery"
import type { Provider } from "../../src/channel/types"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

async function fixture(
  count: number,
  fn: (input: { sessionID: string; rootID: string; ids: string[] }) => Promise<void>,
) {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const session = await Session.create({})
      const sessionID = Identifier.asSessionID(session.id)
      const scopeID = Identifier.asScopeID(session.scope.id)
      const rootID = Identifier.ascending("message")
      const root: MessageV2.User = {
        id: rootID,
        rootID,
        isRoot: true,
        sessionID,
        role: "user",
        origin: { type: "user" },
        visible: true,
        includeInContext: true,
        agent: "test",
        model: { providerID: "test", modelID: "test" },
        time: { created: 10_000 },
        metadata: { channelInboundMessageId: "inbound", channelRequesterId: "requester" },
      }
      await Storage.transaction(async () => {
        for (let index = 0; index < count; index++) {
          const id = Identifier.ascending("message")
          await Storage.write(StoragePath.messageInfo(scopeID, sessionID, id), {
            ...root,
            id,
            rootID: id,
            time: { created: index + 1 },
          })
          const partID = Identifier.ascending("part")
          await Storage.write(StoragePath.messagePart(scopeID, sessionID, id, partID), {
            id: partID,
            sessionID,
            messageID: id,
            type: "text",
            text: "Unrelated historical body",
          })
        }
      })
      await Session.updateMessage(root)
      const ids = [rootID]
      for (const [index, text] of ["Before", "Private", "After"].entries()) {
        const id = Identifier.ascending("message")
        ids.push(id)
        await Session.updateMessage({
          id,
          sessionID,
          parentID: rootID,
          rootID,
          role: "assistant",
          agent: "test",
          mode: "test",
          modelID: "test",
          providerID: "test",
          path: { cwd: tmp.path, root: tmp.path },
          time: { created: 10_001 + index, completed: 10_010 },
          finish: "stop",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })
        await Session.updatePart({ id: Identifier.ascending("part"), sessionID, messageID: id, type: "text", text })
        if (index === 1)
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID,
            messageID: id,
            type: "tool",
            tool: "channel_reaction_only",
            callID: "reaction",
            state: {
              status: "completed",
              input: {},
              title: "Reaction",
              output: "Recorded",
              metadata: { intent: { type: "reaction_only", reaction: "SILENT" } },
              time: { start: 10_002, end: 10_003 },
            },
          })
        if (index === 0 && count)
          await Storage.transaction(async () => {
            for (let part = 0; part < 2_001; part++) {
              const partID = Identifier.ascending("part")
              await Storage.write(StoragePath.messagePart(scopeID, sessionID, id, partID), {
                id: partID,
                sessionID,
                messageID: id,
                type: "reasoning",
                text: "Private reasoning chunk",
                time: { start: 10_001, end: 10_002 },
              })
            }
          })
      }
      await SessionHistory.prepareDisplay(sessionID)
      await fn({ sessionID, rootID, ids })
    },
  })
}

for (const count of [500, 5_000])
  test(
    `one turn with over 2000 Parts shares body reads across delivery after ${count} old messages`,
    () =>
      runtime.run(() =>
        fixture(count, async ({ sessionID, rootID, ids }) => {
          const replies: string[] = []
          const reactions: string[] = []
          const provider: Provider = {
            type: "feishu",
            lifecycle: "self_connected",
            async connect() {},
            async replyMessage(input) {
              replies.push(...input.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])))
              return { messageId: `reply-${replies.length}` }
            },
            async addReaction(input) {
              reactions.push(input.emoji)
            },
          }
          using bodies = spyOn(MessageV2, "parts")
          using history = spyOn(Session, "messages")
          const terminals = await collectChannelTerminalInfos({ sessionID, rootID })
          expect(terminals.map((info) => info.id)).toEqual(ids.slice(1))
          expect(bodies).not.toHaveBeenCalled()
          const plans = await loadChannelDeliveryPlans({ sessionID, rootID, replyToMessageId: "topic" })
          expect(plans.map((plan) => plan.kind)).toEqual(["reply", "reaction", "reply"])
          expect(plans[0].terminal.parts.length).toBeGreaterThan(2_000)
          for (const plan of plans)
            await executeChannelDeliveryPlan({
              sessionID,
              plan,
              provider,
              accountId: "test",
              replyToMessageId: "topic",
            })
          for (const plan of plans)
            await executeChannelDeliveryPlan({
              sessionID,
              plan,
              provider,
              accountId: "test",
              replyToMessageId: "topic",
            })
          expect(replies).toEqual(["Before", "After"])
          expect(reactions).toEqual(["SILENT"])
          expect(bodies.mock.calls.map(([input]) => input.messageID)).toEqual(ids)
          expect(history).not.toHaveBeenCalled()
        }),
      ),
    60_000,
  )

test("concurrent delivery plans serialize one attempt and release their lock after cancellation", () =>
  runtime.run(() =>
    fixture(0, async ({ sessionID, rootID }) => {
      const [, plan] = await loadChannelDeliveryPlans({ sessionID, rootID })
      let sent = 0
      const provider: Provider = {
        type: "feishu",
        lifecycle: "self_connected",
        async connect() {},
        async addReaction() {
          sent++
        },
      }
      const input = { sessionID, plan, provider, accountId: "test" }
      await expect(executeChannelDeliveryPlan({ ...input, signal: AbortSignal.abort() })).rejects.toThrow()
      const outcomes = await Promise.all([executeChannelDeliveryPlan(input), executeChannelDeliveryPlan(input)])
      expect(outcomes.map((outcome) => outcome.status)).toEqual(["delivered", "skipped"])
      expect(sent).toBe(1)
    }),
  ))

test("attachment failure cannot make a successful foreground reply eligible for redelivery", () =>
  runtime.run(() =>
    fixture(0, async ({ sessionID, rootID, ids }) => {
      const asset = await Asset.write(Buffer.from("Attachment"), "text/plain", "result.txt")
      await Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID,
        messageID: ids[1],
        type: "tool",
        callID: "artifact",
        tool: "test",
        state: {
          status: "completed",
          input: {},
          output: "done",
          title: "File",
          metadata: {},
          time: { start: 10_001, end: 10_002 },
          attachments: [
            {
              id: Identifier.ascending("part"),
              sessionID,
              messageID: ids[1],
              type: "attachment",
              mime: "text/plain",
              filename: "result.txt",
              url: `asset://${asset}`,
              model: { mode: "none" },
              presentation: { purpose: "deliverable" },
            },
          ],
        },
      })
      const [plan] = await loadChannelDeliveryPlans({ sessionID, rootID })
      let closes = 0
      const provider: Provider = {
        type: "feishu",
        lifecycle: "self_connected",
        async connect() {},
        async replyMessage() {
          throw new Error("Attachment rejected")
        },
      }
      const input = {
        sessionID,
        plan,
        provider,
        accountId: "test",
        replyToMessageId: "topic",
        foreground: {
          ownsReply: true,
          async close() {
            closes++
          },
          async react() {
            throw new Error("Unexpected reaction")
          },
        },
      }
      expect(await executeChannelDeliveryPlan(input)).toMatchObject({ status: "delivered" })
      expect(await executeChannelDeliveryPlan(input)).toMatchObject({ status: "skipped" })
      expect(closes).toBe(1)
    }),
  ))

test("deleted or rolled-back terminals cannot be revived by a retained plan", () =>
  runtime.run(() =>
    fixture(0, async ({ sessionID, rootID, ids }) => {
      const plans = await loadChannelDeliveryPlans({ sessionID, rootID })
      let sent = 0
      const provider: Provider = {
        type: "feishu",
        lifecycle: "self_connected",
        async connect() {},
        async replyMessage() {
          sent++
          return { messageId: "unexpected" }
        },
        async addReaction() {
          sent++
        },
      }
      await Session.removeMessage({ sessionID, messageID: ids[1] })
      const session = await Session.get(sessionID)
      const historyID = Identifier.ascending("history")
      await Storage.write(
        StoragePath.sessionHistoryEvent(
          Identifier.asScopeID(session.scope.id),
          Identifier.asSessionID(sessionID),
          historyID,
        ),
        {
          id: historyID,
          sessionID,
          type: "rollback",
          time: { created: 20_000 },
          numTurns: 1,
          cutMessageID: ids[2],
          droppedMessageIDs: ids.slice(2),
          droppedUserMessageIDs: [],
          files: [],
          patchPartIDs: [],
        } satisfies SessionHistory.RollbackEvent,
      )
      for (const plan of plans)
        expect(
          await executeChannelDeliveryPlan({ sessionID, plan, provider, accountId: "test", replyToMessageId: "topic" }),
        ).toMatchObject({ status: "skipped" })
      expect(sent).toBe(0)
    }),
  ))
