import { afterAll, expect, spyOn, test } from "bun:test"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Asset } from "@ericsanchezok/synergy-harness/asset/asset"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
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
  fn: (input: {
    sessionID: string
    rootID: string
    ids: string[]
    measurePhase: <T>(phase: string, body: () => Promise<T>) => Promise<T>
    enter: (phase: "root" | "assistant" | "delivery" | "replay", index?: number) => void
  }) => Promise<void>,
) {
  const timing = process.env.CI === "true" || process.env.SYNERGY_CI_TIMING === "1"
  let measurements = 0
  let entries = 0
  async function measurePhase<T>(phase: string, body: () => Promise<T>): Promise<T> {
    const started = performance.now()
    try {
      return await body()
    } finally {
      if (timing && measurements < 15) {
        measurements++
        console.info("delivery-work-timing " + JSON.stringify({ phase, seconds: (performance.now() - started) / 1000 }))
      }
    }
  }
  const enter = (phase: "root" | "assistant" | "delivery" | "replay", index?: number) => {
    if (!timing || entries >= 6) return
    entries++
    console.info("delivery-work-enter " + JSON.stringify({ oldMessages: count, phase, index }))
  }
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
      await measurePhase("delivery-work.seed." + count, async () => {
        const rows: Array<{ key: string[]; value: unknown }> = []
        for (let index = 0; index < count; index++) {
          const id = Identifier.ascending("message")
          rows.push({
            key: StoragePath.messageInfo(scopeID, sessionID, id),
            value: {
              ...root,
              id,
              rootID: id,
              time: { created: index + 1 },
            },
          })
          const partID = Identifier.ascending("part")
          rows.push({
            key: StoragePath.messagePart(scopeID, sessionID, id, partID),
            value: {
              id: partID,
              sessionID,
              messageID: id,
              type: "text",
              text: "Unrelated historical body",
            },
          })
        }
        await Storage.transaction(async (tx) => {
          for (let offset = 0; offset < rows.length; offset += 256) await tx.writeMany(rows.slice(offset, offset + 256))
        })
      })
      enter("root")
      await measurePhase("delivery-work.root." + count, () => Session.updateMessage(root))
      const ids = [rootID]
      for (const [index, text] of ["Before", "Private", "After"].entries()) {
        const id = Identifier.ascending("message")
        ids.push(id)
        enter("assistant", index)
        await measurePhase("delivery-work.assistant." + count + "." + index, () =>
          Session.updateMessage({
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
          }),
        )
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
          await measurePhase("delivery-work.parts." + count, async () => {
            const rows: Array<{ key: string[]; value: unknown }> = []
            for (let part = 0; part < 2_001; part++) {
              const partID = Identifier.ascending("part")
              rows.push({
                key: StoragePath.messagePart(scopeID, sessionID, id, partID),
                value: {
                  id: partID,
                  sessionID,
                  messageID: id,
                  type: "reasoning",
                  text: "Private reasoning chunk",
                  time: { start: 10_001, end: 10_002 },
                },
              })
            }
            await Storage.transaction(async (tx) => {
              for (let offset = 0; offset < rows.length; offset += 256)
                await tx.writeMany(rows.slice(offset, offset + 256))
            })
          })
      }
      await measurePhase("delivery-work.prepare." + count, () => SessionHistory.prepareDisplay(sessionID))
      await fn({ sessionID, rootID, ids, measurePhase, enter })
    },
  })
}

for (const count of [500, 5_000])
  test(
    `one turn with over 2000 Parts shares body reads across delivery after ${count} old messages`,
    () =>
      runtime.run(() =>
        fixture(count, async ({ sessionID, rootID, ids, measurePhase, enter }) => {
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
          const owner = RuntimeContext.current()
          const scopeID = ScopeContext.current.scope.id
          const bodyReads: string[] = []
          let historyReads = 0
          const readParts = MessageV2.parts
          const readHistory = Session.messages
          using bodies = spyOn(MessageV2, "parts").mockImplementation(
            Object.assign(
              (input: Parameters<typeof readParts>[0]) => {
                const current = RuntimeContext.tryCurrent()
                const result = readParts(input)
                if (
                  current === owner &&
                  input.sessionID === sessionID &&
                  (input.scopeID === undefined || input.scopeID === scopeID)
                )
                  bodyReads.push(input.messageID)
                return result
              },
              { force: readParts.force, schema: readParts.schema },
            ),
          )
          using history = spyOn(Session, "messages").mockImplementation(
            Object.assign(
              (input: Parameters<typeof readHistory>[0]) => {
                const current = RuntimeContext.tryCurrent()
                const result = readHistory(input)
                if (current === owner && input.sessionID === sessionID) historyReads++
                return result
              },
              { force: readHistory.force, schema: readHistory.schema },
            ),
          )
          const terminals = await measurePhase("delivery-work.infos." + count, () =>
            collectChannelTerminalInfos({ sessionID, rootID }),
          )
          expect(terminals.map((info) => info.id)).toEqual(ids.slice(1))
          expect(bodyReads).toEqual([])
          const plans = await measurePhase("delivery-work.bodies." + count, () =>
            loadChannelDeliveryPlans({ sessionID, rootID, replyToMessageId: "topic" }),
          )
          expect(plans.map((plan) => plan.kind)).toEqual(["reply", "reaction", "reply"])
          expect(plans[0].terminal.parts.length).toBeGreaterThan(2_000)
          enter("delivery")
          for (const [index, plan] of plans.entries())
            await measurePhase("delivery-work.execute." + count + "." + index, () =>
              executeChannelDeliveryPlan({
                sessionID,
                plan,
                provider,
                accountId: "test",
                replyToMessageId: "topic",
              }),
            )
          enter("replay")
          for (const [index, plan] of plans.entries())
            await measurePhase("delivery-work.replay." + count + "." + index, () =>
              executeChannelDeliveryPlan({
                sessionID,
                plan,
                provider,
                accountId: "test",
                replyToMessageId: "topic",
              }),
            )
          expect(replies).toEqual(["Before", "After"])
          expect(reactions).toEqual(["SILENT"])
          expect(bodyReads).toEqual(ids)
          expect(historyReads).toBe(0)
        }),
      ),
    count === 5_000 ? 120_000 : 60_000,
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
