import { RolloutExecution } from "@ericsanchezok/synergy-harness/rollout"
import { afterAll, expect, spyOn, test } from "bun:test"
import { Hono } from "hono"
import { generateSpecs } from "hono-openapi"
import { testRuntime } from "../support/runtime"
import { fixture, complete } from "@ericsanchezok/synergy-harness/test/support/rollout"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ExecutionRoute } from "../../src/execution/routes"
import { ExecutionService } from "../../src/execution/service"
import { ExecutionSchema } from "../../src/execution/schema"
import { RolloutArtifact } from "@ericsanchezok/synergy-harness/session/rollout/artifact"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { Usage } from "@ericsanchezok/synergy-harness/usage"

const runtime = await testRuntime()
afterAll(() => runtime.close())
const app = new Hono().route("/session", ExecutionRoute())

test("historical usage repair refreshes an already loaded task summary", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      const response = await RolloutArtifact.writeText(
        call.owner,
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":1000,"input_tokens_details":{"cached_tokens":200},"output_tokens":500,"output_tokens_details":{"reasoning_tokens":0}}}}\n\n',
        "application/octet-stream",
      )
      await RolloutLedger.writeAttempt({
        version: 1,
        id: crypto.randomUUID(),
        owner: call.owner,
        runID: rootID,
        callID: call.id,
        index: 0,
        url: "https://fixture.invalid/responses",
        method: "POST",
        started: 1,
        ended: 2,
        status: "completed",
        request: call.request,
        response,
        usageFinal: false,
      })
      await RolloutLedger.finishCall(call.owner, rootID, call.id, { status: "completed", transportCaptured: true })
      await RolloutLedger.finishRun(call.owner, rootID, "completed")
      expect((await ExecutionService.summary(session.id)).accounting.tokens.input.total).toBeNull()
      await Usage.rebuild()
      const stop = Usage.service()
      try {
        for (let i = 0; i < 500 && (await Usage.rebuildStatus())?.status !== "completed"; i++) await Bun.sleep(10)
        expect((await Usage.rebuildStatus())?.status).toBe("completed")
      } finally {
        await stop()
      }
      const summary = await ExecutionService.summary(session.id)
      expect(summary.accounting.tokens.input.total).toBe(1000)
      expect(summary.accounting.apiEstimate.total).toBeCloseTo(0.0101)
      expect(summary.cache.ratio).toBe(0.2)
      expect((await ExecutionService.summary(session.id, rootID)).accounting).toEqual(summary.accounting)
    }),
  ))

test("pausing a later round does not change the outcome of an earlier completed round", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      await complete(call)
      await RolloutLedger.finishRun(call.owner, rootID, "completed")
      const later = Identifier.ascending("message")
      const segment = await RolloutLedger.beginSegment({ owner: call.owner, runID: later, input: {} })
      await RolloutLedger.finishSegment(segment, "interrupted")
      await Session.update(session.id, (draft) => {
        draft.paused = { reason: "aborted", since: Date.now() }
      })
      const summary = await ExecutionService.summary(session.id)
      expect(summary.status).toBe("paused")
      expect(summary.rounds.find((round) => round.id === later)?.status).toBe("paused")
      expect(summary.rounds.find((round) => round.id === rootID)?.status).toBe("completed")
      expect((await ExecutionService.summary(session.id, rootID)).status).toBe("completed")
    }),
  ))

test("task summaries expose persisted origin and delegation controls without changing accounting", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      const interaction = { mode: "unattended" as const, source: "chronicler" }
      await Session.create({ parentID: session.id, title: "Auxiliary", interaction })
      const cortex = {
        taskID: Identifier.ascending("cortex"),
        parentSessionID: session.id,
        parentMessageID: rootID,
        description: "Workflow review",
        agent: "reviewer",
        status: "queued" as const,
        visibility: "hidden" as const,
        startedAt: Date.now(),
      }
      const child = await Session.create({ parentID: session.id, title: "Review", interaction, cortex })
      await complete(call, { inputTokens: 20 })
      const summary = await ExecutionService.summary(session.id)
      expect(summary.tasks).toHaveLength(2)
      expect(summary.tasks.every((task) => task.interaction?.source === "chronicler")).toBe(true)
      expect(summary.tasks.find((task) => task.sessionID === child.id)?.cortex).toEqual({
        taskID: cortex.taskID,
        agent: cortex.agent,
        status: cortex.status,
        visibility: cortex.visibility,
      })
      expect(summary.accounting.tokens.total.known).toBe(520)
      expect(summary.latency.request).toMatchObject({ samples: 0, excluded: 1, meanMs: null })
      expect(summary.outcomes).toMatchObject({ completed: 1, retries: 0 })
      expect(summary.tools).toEqual([])
    }),
  ))

test("an unopened cancelled run does not invent an execution interval", () =>
  runtime.run(() =>
    fixture(async () => {
      const session = await Session.create({ title: "Cancelled before launch" })
      await RolloutLedger.cancelUnopenedRun(
        { kind: "session", scopeID: session.scope.id, sessionID: session.id },
        Identifier.ascending("message"),
        1,
      )
      const summary = await ExecutionService.summary(session.id)
      expect(summary.status).toBe("unknown")
      expect(summary.elapsedMs).toBeNull()
      expect(summary.elapsedActive).toBe(false)
      await Session.remove(session.id)
    }),
  ))

test("execution read endpoints retain distinct OpenAPI operation IDs", async () => {
  const spec = await generateSpecs(app)
  for (const [path, operation] of [
    ["summary", "executionSummary"],
    ["trajectory", "executionTrajectory"],
    ["nodes/{nodeID}", "executionNode"],
    ["nodes/{nodeID}/content", "executionContent"],
  ])
    expect(spec.paths?.["/session/{sessionID}/execution/" + path]?.get?.operationId).toBe("session." + operation)
})

test("execution summaries retain children, canonical usage and durable running status", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      const child = await Session.create({ parentID: session.id, title: "Architecture review" })
      const owner = { kind: "session" as const, scopeID: child.scope.id, sessionID: child.id }
      const childRun = Identifier.ascending("message")
      const segment = await RolloutLedger.beginSegment({
        owner,
        runID: childRun,
        input: {},
        parent: { owner: call.owner, runID: rootID, messageID: rootID },
      })
      await RolloutExecution.provide({ owner, runID: childRun }, () => RolloutExecution.start(segment))
      const childCall = await RolloutLedger.beginCall({
        owner,
        runID: childRun,
        purpose: "analysis",
        model: call.model,
        request: { system: ["fixture"], tools: [{ name: "read", schema: { type: "object" } }] },
      })
      await complete(call, { inputTokens: 20 })
      await RolloutLedger.finishRun(call.owner, rootID, "completed")
      const summary = await (await app.request("/session/" + session.id + "/execution/summary")).json()
      expect(summary.status).toBe("running")
      expect(summary.rounds[0].status).toBe("running")
      expect(summary.elapsedActive).toBe(true)
      expect(summary.tasks).toHaveLength(1)
      expect(summary.tasks[0].title).toBe("Architecture review")
      expect(summary.tasks[0].nodeID).toBeString()
      expect((await ExecutionService.node(session.id, summary.tasks[0].nodeID)).node.sessionID).toBe(child.id)
      expect(summary.accounting.tokens.output.known).toBe(500)
      expect(summary.accounting.tokens.total.known).toBe(520)
      await RolloutLedger.finishCall(owner, childRun, childCall.id, {
        status: "completed",
        sdkUsage: { inputTokens: 7, outputTokens: 3 },
      })
      await RolloutExecution.stop(segment)
      await RolloutLedger.finishSegment(segment, "completed")
      await RolloutLedger.finishRun(owner, childRun, "completed")
      const next = await ExecutionService.summary(session.id)
      expect(next.status).toBe("completed")
      expect(next.tasks).toHaveLength(1)
      expect(next.accounting.tokens.total.known).toBe(530)
      const detail = await ExecutionService.node(session.id, next.tasks[0].nodeID!)
      expect(detail.execution).toMatchObject({
        status: "completed",
        elapsedMs: next.tasks[0].elapsedMs,
        elapsedActive: false,
        elapsedLowerBound: false,
      })
    }),
  ))

test("children created during the initial snapshot are included before returning it", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      const children = Session.children
      let release = () => {}
      let entered = () => {}
      const waiting = new Promise<void>((resolve) => {
        release = resolve
      })
      const ready = new Promise<void>((resolve) => {
        entered = resolve
      })
      let held = false
      const read = spyOn(Session, "children").mockImplementation(
        Object.assign(async (id: string) => {
          const result = await children(id)
          if (id === session.id && !held) {
            held = true
            entered()
            await waiting
          }
          return result
        }, children),
      )
      try {
        const loading = ExecutionService.summary(session.id)
        await ready
        const child = await Session.create({ parentID: session.id, title: "Concurrent analysis" })
        const owner = { kind: "session" as const, scopeID: child.scope.id, sessionID: child.id }
        const segment = await RolloutLedger.beginSegment({
          owner,
          runID: Identifier.ascending("message"),
          input: {},
          parent: { owner: call.owner, runID: rootID, messageID: rootID },
        })
        await RolloutExecution.provide({ owner, runID: segment.runID }, () => RolloutExecution.start(segment))
        release()
        const summary = await loading
        expect(summary.tasks.map((task) => task.sessionID)).toContain(child.id)
        expect(summary.tasks.find((task) => task.sessionID === child.id)?.status).toBe("running")
      } finally {
        release()
        read.mockRestore()
      }
    }),
  ))

test("auxiliary process groups expose each real call without combining saved requests", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      const a = await RolloutLedger.beginCall({
        owner: call.owner,
        runID: rootID,
        purpose: "title",
        usageRole: "auxiliary",
        model: call.model,
        request: { title: "first" },
      })
      const b = await RolloutLedger.beginCall({
        owner: call.owner,
        runID: rootID,
        purpose: "title",
        usageRole: "auxiliary",
        model: call.model,
        request: { title: "second" },
      })
      await complete(a, { inputTokens: 20 })
      await complete(b, { inputTokens: 30 })
      const page = await ExecutionService.trajectory(session.id, ExecutionSchema.Query.parse({ mode: "process" }))
      const group = page.items.find((node) => node.group?.callCount === 2)
      if (!group) throw new Error("Auxiliary calls were not grouped")
      const detail = await ExecutionService.node(session.id, group.id)
      expect(detail.node.group?.callCount).toBe(2)
      expect(detail.related.filter((node) => node.evidenceKind === "call").map((node) => node.callID)).toEqual([
        a.id,
        b.id,
      ])
      expect(JSON.parse((await ExecutionService.content(session.id, group.id, "request", 0, 65_536)).text)).toEqual({
        title: "first",
      })
      const second = detail.related.find((node) => node.callID === b.id)!
      expect(JSON.parse((await ExecutionService.content(session.id, second.id, "request", 0, 65_536)).text)).toEqual({
        title: "second",
      })
      expect((await ExecutionService.node(session.id, second.id)).node.group?.callCount).toBe(1)
    }),
  ))

test("latest main-request context stays separate from cumulative usage and retains its recorded distribution", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      const primary = await RolloutLedger.beginCall({
        owner: call.owner,
        runID: rootID,
        purpose: "conversation",
        usageRole: "conversation",
        model: { ...call.model, limits: { context: 1000, output: 100 } },
        request: {},
      })
      await complete(primary, { inputTokens: 20 })
      const messages: MessageV2.WithParts[] = []
      for await (const message of MessageV2.stream({ sessionID: session.id })) messages.push(message)
      const assistant = messages.find((message) => message.info.role === "assistant")?.info
      if (assistant?.role !== "assistant") throw new Error("Assistant fixture is missing")
      const category = (value: number) => ({ estimatedTokens: value, attributedTokens: value })
      await Session.updateMessage({
        ...assistant,
        accounting: { kind: "rollout", callIDs: [primary.id] },
        contextUsage: {
          version: 1,
          modelID: "test",
          providerID: "test",
          totalInput: 20,
          categories: {
            conversation: category(8),
            toolActivity: category(5),
            filesReferences: category(4),
            instructions: category(2),
          },
          overhead: { attributedTokens: 1 },
          estimator: { kind: "model-tokenizer" },
          reconciliation: { mode: "residual", factor: 1 },
          capturedAt: Date.now(),
        },
      })
      const auxiliary = await RolloutLedger.beginCall({
        owner: call.owner,
        runID: rootID,
        purpose: "auxiliary",
        usageRole: "auxiliary",
        model: call.model,
        request: {},
      })
      await complete(auxiliary, { inputTokens: 30 })
      const summary = await ExecutionService.summary(session.id)
      expect(summary.accounting.tokens.input.known).toBe(50)
      expect(summary.accounting.tokens.output.known).toBe(1000)
      expect(summary.accounting.tokens.reasoning.known).toBe(200)
      expect(summary.accounting.tokens.total.known).toBe(1050)
      expect(summary.context?.inputTokens).toBe(20)
      expect(summary.contextDistribution?.categories.conversation.attributedTokens).toBe(8)
    }),
  ))

test("trajectory cursors, cross-page search and evidence reads stay session-owned", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      const other = await Session.create({})
      expect((await app.request("/session/" + session.id + "/execution/trajectory?session=" + other.id)).status).toBe(
        404,
      )
      expect((await app.request("/session/" + session.id + "/execution/trajectory?runID=unrelated")).status).toBe(404)
      const page = await (await app.request("/session/" + session.id + "/execution/trajectory?limit=1")).json()
      expect(page.items).toHaveLength(1)
      expect(page.nextCursor).toBeString()
      const next = await (
        await app.request("/session/" + session.id + "/execution/trajectory?limit=1&cursor=" + page.nextCursor)
      ).json()
      expect(next.items[0].id).not.toBe(page.items[0].id)
      expect((await app.request("/session/" + session.id + "/execution/trajectory?limit=501")).status).toBe(400)
      expect(
        (await app.request("/session/" + session.id + "/execution/trajectory?kind=tool&cursor=" + page.nextCursor))
          .status,
      ).toBe(400)
      const all = await (await app.request("/session/" + session.id + "/execution/trajectory")).json()
      const model = all.items.find((node: { kind: string }) => node.kind === "model")
      const prefix = "/session/" + session.id + "/execution/nodes/" + model.id
      const detail = await (await app.request(prefix)).json()
      expect(detail.record.id).toBe(call.id)
      expect(detail.sources[0].field).toBe("request")
      expect((await app.request("/session/" + other.id + "/execution/nodes/" + model.id)).status).toBe(404)
      expect((await app.request(prefix + "/content?field=../auth")).status).toBe(404)
      const content = await (await app.request(prefix + "/content?field=request&limit=2")).json()
      expect(content.text).toBe("{}")
      expect(content.bytes).toBe(2)
      expect(content.nextOffset).toBeNull()
      expect((await app.request(prefix + "/content?field=request&limit=65537")).status).toBe(400)
      const search = await (await app.request("/session/" + session.id + "/execution/trajectory?query=summary")).json()
      expect(search.items.some((node: { kind: string }) => node.kind === "model")).toBe(true)
      const selected = await (
        await app.request("/session/" + session.id + "/execution/trajectory?runID=" + rootID)
      ).json()
      expect(selected.items.every((node: { runID: string }) => node.runID === rootID)).toBe(true)
      await using wrongScope = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await wrongScope.scope(),
        fn: async () => {
          expect((await app.request("/session/" + session.id + "/execution/summary")).status).toBe(404)
        },
      })
    }),
  ))

test("a later completed round preserves earlier cancellation without retaining its current status", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      await RolloutLedger.finishCall(call.owner, rootID, call.id, { status: "cancelled" })
      await RolloutLedger.finishRun(call.owner, rootID, "cancelled")
      const nextID = Identifier.ascending("message")
      const next = await RolloutLedger.beginCall({
        owner: call.owner,
        runID: nextID,
        purpose: "next round",
        model: call.model,
        request: {},
      })
      await complete(next, { inputTokens: 25 })
      await RolloutLedger.finishRun(call.owner, nextID, "completed")
      const summary = await ExecutionService.summary(session.id)
      expect(summary.status).toBe("completed")
      expect(summary.rounds).toHaveLength(2)
      expect((await ExecutionService.summary(session.id, rootID)).status).toBe("cancelled")
      expect((await ExecutionService.summary(session.id, nextID)).accounting.tokens.input.known).toBe(25)
    }),
  ))

test(
  "persistent trajectory searches and locates events beyond the first page",
  () =>
    runtime.run(() =>
      fixture(async ({ session, rootID, call }) => {
        for (let index = 0; index < 710; index++)
          await RolloutLedger.beginCall({
            owner: call.owner,
            runID: rootID,
            purpose: "paging-" + index,
            model: call.model,
            request: {},
          })
        const first = await ExecutionService.trajectory(session.id, ExecutionSchema.Query.parse({}))
        expect(first.items).toHaveLength(100)
        const second = await ExecutionService.trajectory(
          session.id,
          ExecutionSchema.Query.parse({ cursor: first.nextCursor }),
        )
        expect(second.items).toHaveLength(100)
        expect(new Set([...first.items, ...second.items].map((node) => node.id)).size).toBe(200)
        const previous = await ExecutionService.trajectory(
          session.id,
          ExecutionSchema.Query.parse({ anchor: second.items[0].id, position: "before" }),
        )
        expect(previous.items.map((node) => node.id)).toEqual(first.items.map((node) => node.id))
        const search = await ExecutionService.trajectory(
          session.id,
          ExecutionSchema.Query.parse({ query: "paging-709" }),
        )
        expect(search.items).toHaveLength(1)
        const located = await ExecutionService.trajectory(
          session.id,
          ExecutionSchema.Query.parse({ anchor: search.items[0].id }),
        )
        expect(located.items.some((node) => node.id === search.items[0].id)).toBe(true)
        const latest = await ExecutionService.trajectory(session.id, ExecutionSchema.Query.parse({ anchor: "latest" }))
        expect(latest.nextCursor).toBeNull()
        expect(latest.items.at(-1)?.preview).toBe("paging-709")
      }),
    ),
  60_000,
)

test("historical messages remain navigable without inventing a completed execution", () =>
  runtime.run(() =>
    fixture(async ({ session }) => {
      const legacy = await Session.create({ title: "Historical conversation" })
      const rootID = Identifier.ascending("message")
      await Session.updateMessage({
        id: rootID,
        sessionID: legacy.id,
        role: "user",
        isRoot: true,
        rootID,
        agent: "synergy",
        model: { providerID: "test", modelID: "test" },
        time: { created: 100 },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: rootID,
        sessionID: legacy.id,
        type: "text",
        text: "历史消息 中文",
      })
      const summary = await ExecutionService.summary(legacy.id)
      expect(summary.status).toBe("unknown")
      expect(summary.coverage.recorded).toBe(0)
      expect(summary.coverage.partial).toBe(true)
      expect(summary.rounds.map((round) => round.id)).toEqual([rootID])
      const round = await ExecutionService.summary(legacy.id, rootID)
      expect(round.status).toBe("unknown")
      const page = await ExecutionService.trajectory(legacy.id, ExecutionSchema.Query.parse({ runID: rootID }))
      const content = await ExecutionService.content(legacy.id, page.items[0].id, "message", 0, 65_536)
      expect(content.text).toContain("历史消息 中文")
      await expect(
        ExecutionService.content(legacy.id, page.items[0].id, "message", content.bytes + 1, 65_536),
      ).rejects.toThrow(RangeError)
      await expect(ExecutionService.node(session.id, page.items[0].id)).rejects.toThrow()
      await Session.remove(legacy.id)
    }),
  ))

test("recorded reasoning timing uses its own interval rather than the whole assistant message", () =>
  runtime.run(() =>
    fixture(async ({ session }) => {
      const messages: MessageV2.WithParts[] = []
      for await (const message of MessageV2.stream({ sessionID: session.id })) messages.push(message)
      const assistant = messages.find((message) => message.info.role === "assistant")?.info
      if (assistant?.role !== "assistant") throw new Error("Assistant fixture is missing")
      await Session.updateMessage({ ...assistant, time: { created: 1000, completed: 10_000 } })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID: session.id,
        messageID: assistant.id,
        type: "reasoning",
        text: "Recorded reasoning",
        time: { start: 1000, end: 2000 },
      })
      const page = await ExecutionService.trajectory(session.id, ExecutionSchema.Query.parse({ kind: "reasoning" }))
      expect(page.items[0].ended! - page.items[0].started).toBe(1000)
    }),
  ))

test("tool inspection uses the actual producing call and preserves raw and model results", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      const first = await RolloutLedger.beginCall({
        owner: call.owner,
        runID: rootID,
        purpose: "first",
        model: call.model,
        request: {
          tools: [
            { id: "read", version: 1 },
            { id: "write", version: 1 },
          ],
        },
      })
      const later = await RolloutLedger.beginCall({
        owner: call.owner,
        runID: rootID,
        purpose: "later",
        model: call.model,
        request: { tools: [{ id: "read", version: 2 }] },
      })
      const messages: MessageV2.WithParts[] = []
      for await (const message of MessageV2.stream({ sessionID: session.id })) messages.push(message)
      const message = messages.find((message) => message.info.role === "assistant")?.info
      if (message?.role !== "assistant") throw new Error("Assistant fixture is missing")
      await Session.updateMessage({ ...message, accounting: { kind: "rollout", callIDs: [first.id, later.id] } })
      const tool = await RolloutLedger.beginTool({
        owner: call.owner,
        runID: rootID,
        messageID: message.id,
        toolCallID: "read-1",
        tool: "read",
        args: { path: "README.md" },
      })
      const rawResult = await RolloutArtifact.writeText(call.owner, "raw result")
      const observation = await RolloutArtifact.writeText(call.owner, "model result")
      await RolloutLedger.writeTool({ ...tool, status: "completed", ended: Date.now(), rawResult, observation })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID: session.id,
        messageID: message.id,
        type: "tool",
        tool: "read",
        callID: "read-1",
        state: {
          status: "completed",
          input: {},
          title: "README.md",
          output: "model result",
          metadata: {},
          time: { start: tool.started, end: Date.now() },
        },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID: session.id,
        messageID: message.id,
        type: "step-finish",
        reason: "tool-calls",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        accounting: { kind: "rollout", callIDs: [first.id] },
      })
      const page = await ExecutionService.trajectory(session.id, ExecutionSchema.Query.parse({ kind: "tool" }))
      const detail = await ExecutionService.node(session.id, page.items[0].id)
      expect(detail.definitions).toEqual([{ id: "read", version: 1 }])
      const producing = await ExecutionService.node(session.id, page.items[0].parentID!)
      expect(producing.definitions).toEqual([
        { id: "read", version: 1 },
        { id: "write", version: 1 },
      ])
      expect((await ExecutionService.content(session.id, page.items[0].id, "rawResult", 0, 64)).text).toBe("raw result")
      expect((await ExecutionService.content(session.id, page.items[0].id, "observation", 0, 64)).text).toBe(
        "model result",
      )
      await expect(ExecutionService.node(session.id, page.items[0].id, "other-round")).rejects.toThrow()
    }),
  ))
