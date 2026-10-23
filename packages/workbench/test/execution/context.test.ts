import { afterAll, expect, spyOn, test } from "bun:test"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { Hono } from "hono"
import { generateSpecs } from "hono-openapi"
import { testRuntime } from "../support/runtime"
import { fixture, complete } from "@ericsanchezok/synergy-harness/test/support/rollout"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { ExecutionRoute } from "../../src/execution/routes"
import { contextDraft } from "@ericsanchezok/synergy-harness/test/support/rollout"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { RolloutCall } from "@ericsanchezok/synergy-harness/test/support/rollout"
import { ExecutionService } from "../../src/execution/service"
import { ExecutionSchema } from "../../src/execution/schema"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { reconcileContextUsage } from "@ericsanchezok/synergy-harness/context"
import { RolloutSnapshot } from "@ericsanchezok/synergy-harness/rollout"
import { Usage } from "@ericsanchezok/synergy-harness/usage"

const runtime = await testRuntime()
afterAll(() => runtime.close())
const app = new Hono().route("/session", ExecutionRoute())

test("context history reads only its session metadata without building descendant message trees", () =>
  runtime.run(() =>
    fixture(async ({ session }) => {
      await Session.create({ parentID: session.id, title: "Unrelated child history" })
      using messages = spyOn(MessageV2, "stream")
      using children = spyOn(Session, "children")
      const page = await ExecutionService.contextHistory(session.id, { limit: 30 })
      expect(page.sessionID).toBe(session.id)
      expect(messages).not.toHaveBeenCalled()
      expect(children).not.toHaveBeenCalled()
    }),
  ))

test("context readers share metadata and request sources never prepare a summary tree", () =>
  runtime.run(() =>
    fixture(async ({ session, call: seed, rootID }) => {
      const call = await RolloutLedger.beginCall({
        owner: seed.owner,
        runID: rootID,
        purpose: "general",
        usageRole: "conversation",
        model: seed.model,
        request: {},
      })
      using bootstrap = spyOn(RolloutSnapshot, "modelCalls")
      using children = spyOn(Session, "children")
      using bodies = spyOn(MessageV2, "parts")
      const [page, snapshot] = await Promise.all([
        ExecutionService.contextHistory(session.id, { limit: 30 }),
        ExecutionService.contextSnapshot(session.id, call.id),
      ])
      expect(page.items.find((item) => item.callID === call.id)).toEqual(snapshot)
      await ExecutionService.contextItems(session.id, call.id, ExecutionSchema.ContextItemsQuery.parse({}))
      const detail = await ExecutionService.node(session.id, snapshot.nodeID)
      expect(detail.node.callID).toBe(call.id)
      await ExecutionService.contextHistory(session.id, { limit: 30 })
      expect(bootstrap).toHaveBeenCalledTimes(1)
      expect(children).not.toHaveBeenCalled()
      expect(bodies).not.toHaveBeenCalled()
      await ExecutionService.summary(session.id)
      expect(await ExecutionService.node(session.id, snapshot.nodeID)).toEqual(detail)
    }),
  ))

test("formal attribution retains its call identity when an assistant contains a later retry", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      const args = {
        owner: call.owner,
        runID: rootID,
        purpose: "general",
        usageRole: "conversation" as const,
        model: call.model,
        request: {},
      }
      const first = await RolloutLedger.beginCall(args)
      const next = await RolloutLedger.beginCall({ ...args, retryIndex: 1 })
      const message = (await Session.messages({ sessionID: session.id })).find(
        (entry) => entry.info.role === "assistant",
      )!.info
      if (message.role !== "assistant") throw new Error("Missing assistant fixture")
      const formal = { ...reconcileContextUsage(contextDraft(), 80), callID: first.id }
      await Session.updateMessage({
        ...message,
        accounting: { kind: "rollout", callIDs: [first.id, next.id] },
        contextUsage: formal,
      })
      const base = `/session/${session.id}/execution/context/snapshots/`
      expect((await (await app.request(base + next.id)).json()).usage).toBeNull()
      expect((await (await app.request(base + first.id)).json()).usage.totalInput).toBe(80)
      await Session.updateMessage({ ...message, accounting: { kind: "rollout", callIDs: [first.id, next.id] } })
      await Session.updateAssistantContextUsage({ sessionID: session.id, messageID: message.id, contextUsage: formal })
      expect(
        (await Session.messages({ sessionID: session.id })).find((entry) => entry.info.id === message.id)!.info,
      ).not.toHaveProperty("contextUsage")
    }),
  ))

test("late metadata notifications cannot replace newer canonical context attribution or usage", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      const next = await RolloutLedger.beginCall({
        owner: call.owner,
        runID: rootID,
        purpose: "general",
        usageRole: "conversation",
        model: call.model,
        request: {},
      })
      const before = (await Usage.collect({ sessionID: session.id })).filter(
        (record) => record.kind === "call" && record.entityID === next.id,
      )
      const info = (await Session.messages({ sessionID: session.id })).find(
        (message) => message.info.role === "assistant",
      )!.info
      if (info.role !== "assistant") throw new Error("Missing assistant fixture")
      await Session.updateMessage({
        ...info,
        accounting: { kind: "rollout", callIDs: [next.id] },
        contextUsage: { ...reconcileContextUsage(contextDraft(), 80), callID: next.id },
      })
      await complete(next, { inputTokens: 80 })
      const current = await ExecutionService.contextSnapshot(session.id, next.id)
      expect(current.usage?.totalInput).toBe(80)
      expect(before.length).toBeGreaterThan(0)
      for (const record of before)
        await Bus.publish(Usage.Updated, {
          owner: next.owner,
          record,
          revision: record.revision,
          runID: record.runID,
          recordID: record.id,
          kind: record.kind,
          status: record.status,
          phase: "queued",
        })
      await Bus.publish(MessageV2.Event.Updated, { info })
      expect(await ExecutionService.contextSnapshot(session.id, next.id)).toEqual(current)
    }),
  ))

test("running request estimates stay out of accounting and calibrate with provider totals without cache details", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      const next = await RolloutLedger.beginCall({
        owner: call.owner,
        runID: rootID,
        purpose: "general",
        usageRole: "conversation",
        model: call.model,
        request: { messages: [{ role: "user", content: "hello" }] },
      })
      const base = `/session/${session.id}/execution/context/snapshots/${next.id}`
      const before = await ExecutionService.summary(session.id)
      await RolloutLedger.updateContextEstimate(next.owner, next.runID, next.id, {
        ...contextDraft(),
        version: 1,
        capturedAt: Date.now(),
      })
      const after = await ExecutionService.summary(session.id)
      expect(after.accounting).toEqual(before.accounting)
      expect(after.cost).toEqual(before.cost)
      expect(after.cache).toEqual(before.cache)
      const pending = await (await app.request(base)).json()
      expect(pending.status).toBe("running")
      expect(pending.inputTokens).toBeNull()
      expect(pending.usage).toBeNull()
      expect(pending.estimate.categories.userMessages.estimatedTokens).toBe(80)
      await complete(next, { inputTokens: 60, omitCacheDetails: true })
      const measured = await (await app.request(base)).json()
      expect(measured.inputTokens).toBe(60)
      expect(measured.usage.totalInput).toBe(60)
      expect(
        measured.usage.categories.find((entry: { category: string }) => entry.category === "userMessages")
          .attributedTokens,
      ).toBe(60)
      expect(measured.cacheHit).toBeNull()
      await RolloutLedger.updateContextEstimate(next.owner, next.runID, next.id, {
        ...contextDraft(100),
        version: 1,
        capturedAt: Date.now(),
      })
      expect((await (await app.request(base)).json()).usage.totalInput).toBe(60)
    }),
  ))

test("execution projections deliver live classification without repeating unchanged contexts", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      await ExecutionService.summary(session.id)
      const draft = Promise.withResolvers<ReturnType<typeof contextDraft>>()
      const delivered = Promise.withResolvers<void>()
      const unchanged = Promise.withResolvers<ExecutionSchema.ContextSnapshot[]>()
      let classified = false
      let callID = ""
      const unsubscribe = Bus.subscribeGlobal(ExecutionSchema.Updated, (event) => {
        if (event.properties.sessionID !== session.id) return
        if (classified) {
          unchanged.resolve(event.properties.contextUpserts ?? [])
          return
        }
        const snapshot = event.properties.contextUpserts?.find((entry) => entry.callID === callID && entry.estimate)
        if (!snapshot) return
        expect(snapshot.status).toBe("running")
        expect(snapshot.inputTokens).toBeNull()
        delivered.resolve()
      })
      const stream = await RolloutCall.stream(
        {
          owner: call.owner,
          runID: rootID,
          purpose: "general",
          usageRole: "conversation",
          model: call.model,
          request: { messages: [] },
        },
        async () => ({
          contextUsageDraft: draft.promise,
          fullStream: (async function* () {})(),
          usage: Promise.resolve(undefined),
          async dispose() {},
        }),
      )
      callID = stream.rollout!.callID
      const release = ExecutionService.subscribe(session.id)
      let timer = setTimeout(
        () => delivered.reject(new Error("Classification update missing during model execution")),
        3000,
      )
      try {
        draft.resolve(contextDraft())
        await delivered.promise
        const snapshot = await (
          await app.request(`/session/${session.id}/execution/context/snapshots/${callID}`)
        ).json()
        expect(snapshot.estimate.categories.userMessages.estimatedTokens).toBe(80)
        clearTimeout(timer)
        timer = setTimeout(() => unchanged.reject(new Error("Unchanged context update missing")), 3000)
        classified = true
        await Session.update(session.id, (info) => {
          info.title = "Same context, updated session"
        })
        expect(await unchanged.promise).toEqual([])
      } finally {
        clearTimeout(timer)
        unsubscribe()
        release()
        await stream.dispose()
      }
    }),
  ))

test("actual input arriving first is calibrated when its delayed estimate is persisted", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      const next = await RolloutLedger.beginCall({
        owner: call.owner,
        runID: rootID,
        purpose: "general",
        usageRole: "conversation",
        model: call.model,
        request: {},
      })
      await complete(next, { inputTokens: 123, omitCacheDetails: true })
      const base = `/session/${session.id}/execution/context/snapshots/${next.id}`
      expect((await (await app.request(base)).json()).usage).toBeNull()
      await RolloutLedger.updateContextEstimate(next.owner, next.runID, next.id, {
        ...contextDraft(),
        version: 1,
        capturedAt: Date.now(),
      })
      const calibrated = await (await app.request(base)).json()
      expect(calibrated.usage.totalInput).toBe(123)
      expect(calibrated.usage.overhead.attributedTokens).toBe(43)
      expect(
        calibrated.usage.categories.reduce(
          (sum: number, entry: { attributedTokens: number }) => sum + entry.attributedTokens,
          0,
        ),
      ).toBe(80)
    }),
  ))

test("context routes have distinct generated operations", async () => {
  const spec = await generateSpecs(app)
  for (const [path, operation] of [
    ["history", "executionContextHistory"],
    ["snapshots/{callID}", "executionContextSnapshot"],
    ["snapshots/{callID}/items", "executionContextItems"],
  ])
    expect(spec.paths?.["/session/{sessionID}/execution/context/" + path]?.get?.operationId).toBe(
      "session." + operation,
    )
})

test("context history pages only main conversation requests and reads bounded source metadata", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      const created = []
      for (let index = 0; index < 3; index++) {
        const next = await RolloutLedger.beginCall({
          owner: call.owner,
          runID: rootID,
          purpose: "general",
          usageRole: "conversation",
          model: call.model,
          request: {
            messages: [{ role: "user", content: "fixture content" }],
            contextSources: [
              {
                category: "userMessages",
                path: ["messages", "0"],
                selector: ["content"],
                source: "userMessages",
                characters: 15,
                precision: "source",
              },
            ],
          },
        })
        await complete(next, { inputTokens: index + 10 })
        created.push(next)
      }
      const base = "/session/" + session.id + "/execution/context/"
      using current = spyOn(RolloutSnapshot, "current")
      using replay = spyOn(RolloutSnapshot, "read")
      const response = await app.request(base + "history?limit=2")
      expect(response.status).toBe(200)
      const page = await response.json()
      expect(page.total).toBe(3)
      expect(page.items.map((item: { callID: string }) => item.callID)).toEqual(
        created
          .slice(1)
          .reverse()
          .map((item) => item.id),
      )
      expect(page.items[0].usage).toBeNull()
      expect(page.items[0].inputTokens).toBe(12)
      const appended = await RolloutLedger.beginCall({
        owner: call.owner,
        runID: rootID,
        purpose: "general",
        usageRole: "conversation",
        model: call.model,
        request: {},
      })
      const older = await (
        await app.request(base + "history?limit=2&cursor=" + encodeURIComponent(page.nextCursor))
      ).json()
      expect(older.items.map((item: { callID: string }) => item.callID)).toEqual([created[0].id])
      expect(older.total).toBe(4)
      const latest = await (await app.request(base + "history?limit=1")).json()
      expect(latest.items[0]).toMatchObject({ callID: appended.id, requestNumber: 4, roundNumber: 1 })
      const other = await RolloutLedger.beginCall({
        owner: call.owner,
        runID: "other-round",
        purpose: "general",
        usageRole: "conversation",
        model: call.model,
        request: {},
      })
      const scoped = await (await app.request(base + "history?runID=other-round")).json()
      expect(scoped.total).toBe(1)
      expect(scoped.items[0]).toMatchObject({ callID: other.id, requestNumber: 5, roundNumber: 2 })
      expect((await app.request(base + "snapshots/" + created[0].id + "?runID=other-round")).status).toBe(404)
      expect((await app.request(base + "history?runID=missing")).status).toBe(404)
      expect(
        (await app.request(base + "history?runID=other-round&cursor=" + encodeURIComponent(page.nextCursor))).status,
      ).toBe(400)
      const items = await (
        await app.request(base + "snapshots/" + created[0].id + "/items?category=userMessages")
      ).json()
      expect(items.items).toHaveLength(1)
      expect(items.items[0]).toMatchObject({ source: "userMessages", selector: ["content"], characters: 15 })
      expect(items.items[0].bytes).toBeGreaterThan(0)
      expect(JSON.stringify(items)).not.toContain("fixture content")
      expect((await app.request(base + "snapshots/" + call.id)).status).toBe(404)
      expect((await app.request(base + "history?limit=501")).status).toBe(400)
      expect((await app.request(base + "snapshots/" + created[0].id + "/items?version=wrong")).status).toBe(400)
      expect(current).not.toHaveBeenCalled()
      expect(replay).not.toHaveBeenCalled()
    }),
  ))

test(
  "large context evidence keeps source metadata reachable without returning prompt bodies",
  () =>
    runtime.run(() =>
      fixture(async ({ session, rootID, call }) => {
        const entries = Array.from({ length: 12_050 }, (_, index) => ({
          role: "user",
          content: `source-${index}:` + "x".repeat(1024),
        }))
        const sources = entries.map((entry, index) => ({
          category: "userMessages",
          path: ["messages", String(index)],
          selector: ["content"],
          source: `source-${index}`,
          characters: entry.content.length,
          precision: "source",
        }))
        const next = await RolloutLedger.beginCall({
          owner: call.owner,
          runID: rootID,
          purpose: "general",
          usageRole: "conversation",
          model: call.model,
          request: { messages: entries, contextSources: sources },
        })
        await complete(next)
        const base = `/session/${session.id}/execution/context/snapshots/${next.id}/items`
        const response = await app.request(base + "?limit=30")
        expect(response.status).toBe(200)
        const page = await response.json()
        expect(page.status).toBe("available")
        expect(page.items).toHaveLength(30)
        expect(page.total).toBeLessThanOrEqual(10_000)
        expect(page.truncated).toBe(true)
        expect(JSON.stringify(page)).not.toContain("x".repeat(256))
        const older = await (await app.request(base + "?limit=30&cursor=" + encodeURIComponent(page.nextCursor))).json()
        expect(older.items[0].id).not.toBe(page.items[0].id)
        expect(
          (await app.request(base + "?query=different&cursor=" + encodeURIComponent(page.nextCursor))).status,
        ).toBe(400)
      }),
    ),
  30_000,
)
