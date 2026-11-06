import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test"
import { z } from "zod"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { Agent } from "../../src/agent/agent"
import { PrimaryAgentIdentity } from "../../src/agent/primary-identity"
import { Cortex } from "../../src/cortex"
import { TaskTool } from "../../src/cortex/tools/task"
import { TaskOutputTool } from "../../src/cortex/tools/task-output"
import { Identifier } from "../../src/id/id"
import { ObservabilityClock } from "../../src/observability/clock"
import { ObservabilityConfig } from "../../src/observability/config"
import { ObservabilityIssues } from "../../src/observability/issues"
import { ObservabilityStore } from "../../src/observability/store"
import { Provider } from "../../src/provider/provider"
import { ProcessRegistry } from "../../src/process/registry"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { AgentTurn } from "../../src/session/agent-turn"
import type { AgentTurnProtocol } from "../../src/session/agent-turn/protocol"
import { ExecutionCapacity } from "../../src/session/execution-capacity"
import { createUserMessage } from "../../src/session/input"
import { SessionManager } from "../../src/session/manager"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { RolloutCall } from "../../src/session/rollout/call"
import { ToolResolver } from "../../src/session/tool-resolver"
import { ToolScheduler } from "../../src/session/tool-scheduler"
import { ToolRegistry } from "../../src/tool/registry"
import { ToolPolicySource } from "../../src/tool/policy-source"
import { Tool } from "../../src/tool/tool"
import { TimeoutConfig } from "../../src/util/timeout-config"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"
import { clearObservabilityState, resetObservabilityState } from "../observability/fixture"

let execute: (ctx: Tool.Context) => Promise<void>
const probe = Tool.define("execution_probe", {
  description: "Observe a controlled execution",
  parameters: z.object({}),
  async execute(_input, ctx) {
    await execute(ctx)
    return { title: "probe", output: "done", metadata: {} }
  },
})
const runtime = await testRuntime({
  register() {
    ToolRegistry.registerToolProvider("execution-observability", () => [probe, TaskOutputTool, TaskTool])
  },
})
afterAll(() => runtime.close())
afterEach(() =>
  runtime.run(async () => {
    mock.restore()
    await ToolScheduler.stop()
    ToolScheduler.configure()
    ToolResolver.stop()
    Cortex.reset()
    clearObservabilityState()
  }),
)

const model: Provider.Model = {
  id: "test-model",
  providerID: "test",
  api: { id: "test-model", url: "https://example.invalid", npm: "@ai-sdk/openai-compatible" },
  name: "Test Model",
  capabilities: {
    temperature: false,
    reasoning: true,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128_000, output: 4096 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
  family: "test",
}
const agent = Agent.Info.parse({
  name: "execution-fixture",
  mode: "primary",
  delegationGroups: [PrimaryAgentIdentity.names.general],
  controlProfile: "full_access",
  permission: [],
  options: {},
})

async function turn() {
  const session = await Session.create({ controlProfile: "full_access" })
  const user = await createUserMessage({
    sessionID: session.id,
    model: { providerID: model.providerID, modelID: model.id },
    parts: [{ type: "text", text: "observe execution" }],
  })
  const assistant: MessageV2.Assistant = {
    id: Identifier.ascending("message"),
    sessionID: session.id,
    role: "assistant",
    time: { created: Date.now() },
    parentID: user.info.id,
    rootID: user.info.id,
    modelID: model.id,
    providerID: model.providerID,
    mode: "test",
    agent: agent.name,
    path: { cwd: ScopeContext.current.directory, root: ScopeContext.current.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  await Session.updateMessage(assistant)
  const lease = SessionManager.acquire(session.id)!
  SessionManager.bindRootTask(lease, user.info.id)
  const processor = SessionProcessor.create({
    assistantMessage: assistant,
    sessionID: session.id,
    model,
    abort: lease.signal,
    generation: lease.generation,
  })
  return { session, user: user.info, assistant, lease, processor }
}

async function fixture(run: (clock: { now: number }) => Promise<void>) {
  resetObservabilityState()
  ObservabilityConfig.refresh({ observability: { performance: { thresholds: { slowToolMs: 30_000 } } } })
  const clock = { now: Date.now() }
  using wall = spyOn(Date, "now").mockImplementation(() => clock.now)
  using telemetry = spyOn(ObservabilityClock, "now").mockImplementation(() => clock.now)
  using mark = spyOn(ObservabilityClock, "start").mockImplementation(() => clock.now)
  using duration = spyOn(ObservabilityClock, "durationMs").mockImplementation((start) => clock.now - start)
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({ scope: await tmp.scope(), fn: () => run(clock) })
}

async function tools(current: Awaited<ReturnType<typeof turn>>) {
  return ToolResolver.resolveWithAvailability({
    ...current,
    sessionID: current.session.id,
    model,
    agent,
    includeMCP: false,
  })
}

function inflight(sessionID: string) {
  ToolResolver.sweepActiveTraces()
  return ObservabilityStore.queryInflight({ sessionID }).find((span) => span.name === "tool.execution")!
}

for (const count of [256, 1024])
  test(`${count} growing metadata callbacks observe only their coalesced effective update`, () =>
    runtime.run(() =>
      fixture(async (clock) => {
        const current = await turn()
        const resolved = await tools(current)
        const rawValues = new WeakSet<object>()
        const stringify = JSON.stringify
        const clone = structuredClone
        const updatePart = Session.updatePart
        let scannedBytes = 0
        let rawClones = 0
        let persistedUpdates = 0
        let latestOutputLength = 0
        let initialProgress: number | null | undefined
        let callbackProgress: number | null | undefined
        let effectiveProgress: number | null | undefined
        using writes = spyOn(Session, "updatePart").mockImplementation((async (
          input: Parameters<typeof Session.updatePart>[0],
        ) => {
          const part = "part" in input ? input.part : input
          if (
            part.type === "tool" &&
            part.callID === "growing-metadata" &&
            part.state.status === "running" &&
            typeof part.state.metadata?.output === "string"
          ) {
            persistedUpdates++
            latestOutputLength = part.state.metadata.output.length
          }
          return updatePart(input)
        }) as unknown as typeof Session.updatePart)
        using serialization = spyOn(JSON, "stringify").mockImplementation(((
          value: unknown,
          replacer?: ((this: unknown, key: string, value: unknown) => unknown) | (number | string)[] | null,
          space?: string | number,
        ) => {
          const serialized =
            typeof replacer === "function" ? stringify(value, replacer, space) : stringify(value, replacer, space)
          if (value && typeof value === "object" && rawValues.has(value)) scannedBytes += serialized?.length ?? 0
          return serialized
        }) as typeof JSON.stringify)
        using cloning = spyOn(globalThis, "structuredClone").mockImplementation((<Value>(
          value: Value,
          options?: Parameters<typeof structuredClone>[1],
        ) => {
          if (value && typeof value === "object" && rawValues.has(value)) rawClones++
          return clone(value, options)
        }) as unknown as typeof structuredClone)
        execute = async (ctx) => {
          initialProgress = inflight(current.session.id).last_activity_time
          clock.now += 31_000
          const pending: Promise<void>[] = []
          let output = ""
          for (let index = 0; index < count; index++) {
            output += "x".repeat(1024)
            const value = { metadata: { output } }
            rawValues.add(value)
            rawValues.add(value.metadata)
            pending.push(Promise.resolve(ctx.metadata(value)))
          }
          callbackProgress = inflight(current.session.id).last_activity_time
          await Promise.all(pending)
          effectiveProgress = inflight(current.session.id).last_activity_time
        }
        try {
          await current.processor.executeToolCall({
            callID: "growing-metadata",
            toolName: probe.id,
            args: {},
            tool: resolved.executionTools[probe.id],
          })
          expect(scannedBytes).toBe(0)
          expect(rawClones).toBe(0)
          expect(persistedUpdates).toBe(1)
          expect(latestOutputLength).toBe(count * 1024)
          expect(callbackProgress).toBe(initialProgress)
          expect(effectiveProgress).toBe(clock.now)
        } finally {
          await SessionManager.release(current.lease, { requestNextWork: false })
        }
      }),
    ))

test("tool progress, known waiting and unknown silence are not inferred as stalls from duration", () =>
  runtime.run(() =>
    fixture(async (clock) => {
      const current = await turn()
      const resolved = await ToolResolver.resolveWithAvailability({
        ...current,
        sessionID: current.session.id,
        model,
        agent,
        includeMCP: false,
      })
      const inspect = () => {
        ToolResolver.sweepActiveTraces(clock.now)
        return ObservabilityStore.queryInflight({ sessionID: current.session.id }).find(
          (span) => span.name === "tool.execution",
        )!
      }
      execute = async (ctx) => {
        await ctx.metadata({ metadata: { output: "compiling" } })
        const progressed = inspect().last_activity_time
        clock.now += 31_000
        await ctx.metadata({ metadata: { output: "compiling more" } })
        expect(inspect().last_activity_time).toBe(clock.now)
        expect(inspect().last_activity_time).toBeGreaterThan(progressed!)
        clock.now += 31_000
        await ctx.metadata({ metadata: { output: "compiling more" } })
        expect(inspect().last_activity_time).toBe(clock.now - 31_000)
        expect(JSON.parse(inspect().attributes_json).activityState).toBe("unknown")
        expect(inspect().stalled).toBe(0)
        expect(ctx.execution).toBeDefined()
        const finishWait = ctx.execution!.waiting("child")
        clock.now += 60_000
        expect(JSON.parse(inspect().attributes_json)).toMatchObject({
          executionPhase: "waiting_background",
          waitReason: "child",
          activityState: "waiting",
        })
        expect(inspect().stalled).toBe(0)
        finishWait()
        await ExecutionCapacity.wait(async () => {
          clock.now += 60_000
          expect(JSON.parse(inspect().attributes_json)).toMatchObject({
            executionPhase: "queued_tools",
            waitReason: "capacity",
          })
          expect(inspect().stalled).toBe(0)
        })
        await ExecutionCapacity.detached(() =>
          ExecutionCapacity.wait(async () => {
            clock.now += 60_000
            expect(JSON.parse(inspect().attributes_json).waitReason).toBe("none")
          }),
        )
        using permission = spyOn(ToolPolicySource, "requestPermission").mockImplementation(async () => {
          clock.now += 60_000
          expect(JSON.parse(inspect().attributes_json)).toMatchObject({
            executionPhase: "authorizing_tools",
            waitReason: "authorization",
          })
          expect(inspect().stalled).toBe(0)
          return true
        })
        await ctx.ask({ permission: "execution-fixture", patterns: ["*"], metadata: {} })
      }
      try {
        const result = await current.processor.executeToolCall({
          callID: "observed-tool",
          toolName: probe.id,
          args: {},
          tool: resolved.executionTools[probe.id],
        })
        expect(result.output).toBe("done")
        expect(
          ObservabilityIssues.list({ module: "tool" }).some((issue) => issue.code === "PERF_TOOL_SLOW_EXECUTION"),
        ).toBe(true)
        expect(
          ObservabilityIssues.list({ module: "tool" }).filter((issue) => issue.code === "PERF_TOOL_STALLED"),
        ).toEqual([])
      } finally {
        await SessionManager.release(current.lease, { requestNextWork: false })
      }
    }),
  ))

test.each(["reasoning", "text", "tool", "unknown-dispatch"] as const)(
  "%s first content uses transport dispatch, preserves legacy first delta and observes long streams",
  (kind) =>
    runtime.run(() =>
      fixture(async (clock) => {
        const current = await turn()
        const queuedAt = clock.now
        const openedAt = queuedAt + 50_000
        const sentAt = queuedAt + 40_000
        let requestSpanID: string | undefined
        let lastProgressAt: number | undefined
        spyOn(AgentTurn, "stream").mockImplementation(async (input) =>
          RolloutCall.stream(
            {
              owner: { kind: "session", scopeID: ScopeContext.current.scope.id, sessionID: current.session.id },
              runID: current.user.id,
              purpose: "fixture",
              request: {},
              model: { providerID: model.providerID, modelID: model.id, sdk: "test", pricing: null },
            },
            async (archive) => {
              clock.now = sentAt
              input.onPhase?.("waiting_model")
              if (kind !== "unknown-dispatch") {
                await archive({
                  type: "attempt-start",
                  attemptID: crypto.randomUUID(),
                  url: "https://example.invalid",
                  method: "POST",
                  mediaType: "application/json",
                  timing: {
                    source: "transport",
                    sentAt,
                    contentEvents: 0,
                    reasoningObserved: false,
                    streaming: true,
                  },
                })
              }
              clock.now = openedAt
              const emit = async function* (): AsyncGenerator<AgentTurnProtocol.StreamEvent> {
                yield { type: "start" }
                if (kind === "text") {
                  yield { type: "text-start", id: "text" }
                  clock.now = openedAt + 5
                  yield { type: "text-delta", id: "text", text: "" }
                  clock.now = openedAt + 10
                  yield { type: "text-delta", id: "text", text: "   " }
                } else if (kind !== "tool") {
                  yield { type: "reasoning-start", id: "reasoning" }
                  clock.now = openedAt + 5
                  yield { type: "reasoning-delta", id: "reasoning", text: "" }
                  clock.now = openedAt + 10
                  yield { type: "reasoning-delta", id: "reasoning", text: "   " }
                }
                clock.now = openedAt + 20
                if (kind === "reasoning") {
                  yield { type: "reasoning-delta", id: "reasoning", text: "thinking" }
                } else if (kind === "tool") {
                  yield { type: "tool-input-start", id: "model-tool", toolName: probe.id }
                  yield { type: "tool-input-delta", id: "model-tool", delta: "" }
                  clock.now = openedAt + 25
                  yield { type: "tool-input-delta", id: "model-tool", delta: "{}" }
                  const toolSpan = ObservabilityStore.queryInflight({ sessionID: current.session.id }).find(
                    (span) => span.name === "llm.request",
                  )!
                  requestSpanID = toolSpan.span_id
                  lastProgressAt = clock.now
                  expect(toolSpan.last_activity_time).toBeGreaterThanOrEqual(openedAt + 20)
                  expect(toolSpan.last_activity_time).toBeLessThanOrEqual(clock.now)
                  yield { type: "tool-call", toolCallId: "model-tool", toolName: probe.id, input: {} }
                }
                if (kind === "reasoning" || kind === "unknown-dispatch")
                  yield { type: "reasoning-end", id: "reasoning" }
                if (kind !== "tool") {
                  if (kind !== "text") yield { type: "text-start", id: "text" }
                  clock.now = openedAt + 30
                  yield { type: "text-delta", id: "text", text: "" }
                  clock.now = openedAt + 40
                  yield { type: "text-delta", id: "text", text: "answer" }
                  for (let index = 1; index <= 3; index++) {
                    clock.now += 20_000
                    yield { type: "text-delta", id: "text", text: " more" }
                    const span = ObservabilityStore.queryInflight({ sessionID: current.session.id }).find(
                      (span) => span.name === "llm.request",
                    )!
                    requestSpanID = span.span_id
                    lastProgressAt = clock.now
                    expect(span.last_activity_time).toBe(clock.now)
                    expect(span.stalled).toBe(0)
                  }
                  yield { type: "text-end", id: "text" }
                }
              }
              return { fullStream: emit(), usage: Promise.resolve(undefined), async dispose() {} }
            },
          ),
        )
        try {
          execute = async () => {}
          const resolved = await ToolResolver.resolveWithAvailability({
            ...current,
            sessionID: current.session.id,
            model,
            agent,
            includeMCP: false,
          })
          await current.processor.process({
            user: current.user,
            sessionID: current.session.id,
            model,
            agent,
            system: [],
            messages: [],
            abort: current.lease.signal,
            toolDefinitions: resolved.definitions,
            executionTools: resolved.executionTools,
            executorKinds: resolved.executorKinds,
          })
          expect(current.processor.message.error).toBeUndefined()
          const rows = ObservabilityStore.queryMetrics({ since: queuedAt, sessionID: current.session.id })
          const firstDelta = rows.filter((row) => row.name === "llm.stream.first_token")
          expect(firstDelta.map((row) => row.value)).toEqual(kind === "tool" ? [] : [5])
          if (firstDelta[0])
            expect(JSON.parse(firstDelta[0].labels_json)).toMatchObject({
              clock: "stream_opened",
              semantics: "first_text_or_reasoning_delta",
              kind: kind === "text" ? "text" : "reasoning",
            })
          const content = rows.filter((row) => row.name === "llm.stream.first_content")
          const visible = rows.filter((row) => row.name === "llm.stream.first_visible_text")
          if (kind === "unknown-dispatch") {
            expect(content).toEqual([])
            expect(visible).toEqual([])
            expect(rows.find((row) => row.name === "llm.stream.first_content.unavailable")).toBeDefined()
          } else {
            expect(content).toHaveLength(1)
            expect(content[0].value).toBe(kind === "text" ? 10_040 : 10_020)
            expect(JSON.parse(content[0].labels_json)).toMatchObject({ clock: "transport.sentAt", kind })
            expect(visible.map((row) => row.value)).toEqual(kind === "tool" ? [] : [10_040])
          }
          if (requestSpanID) {
            const finished = ObservabilityStore.querySpans({ sessionID: current.session.id }).find(
              (span) => span.span_id === requestSpanID,
            )!
            expect(finished.status).toBe("ok")
            expect(finished.last_activity_time).toBe(lastProgressAt)
          }
        } finally {
          await SessionManager.release(current.lease, { requestNextWork: false })
        }
      }),
    ),
)

test.each(["missing-dispatch", "timed", "overlap"] as const)(
  "%s retry timing never borrows a different attempt's dispatch",
  (mode) =>
    runtime.run(() =>
      fixture(async (clock) => {
        const current = await turn()
        const initial = clock.now
        const firstID = crypto.randomUUID()
        const secondID = crypto.randomUUID()
        spyOn(AgentTurn, "stream").mockImplementation(async () =>
          RolloutCall.stream(
            {
              owner: { kind: "session", scopeID: ScopeContext.current.scope.id, sessionID: current.session.id },
              runID: current.user.id,
              purpose: "fixture",
              request: {},
              model: { providerID: model.providerID, modelID: model.id, sdk: "test", pricing: null },
            },
            async (archive) => {
              clock.now = initial + 40_000
              await archive({
                type: "attempt-start",
                attemptID: firstID,
                url: "https://example.invalid",
                method: "POST",
                mediaType: "application/json",
                timing: {
                  source: "transport",
                  sentAt: clock.now,
                  contentEvents: 0,
                  reasoningObserved: false,
                  streaming: true,
                },
              })
              if (mode !== "overlap") {
                clock.now = initial + 42_000
                await archive({ type: "attempt-end", attemptID: firstID, status: "failed", error: "request rejected" })
              }
              clock.now = initial + 45_000
              await archive({
                type: "attempt-start",
                attemptID: secondID,
                url: "https://example.invalid",
                method: "POST",
                mediaType: "application/json",
                ...(mode !== "missing-dispatch"
                  ? {
                      timing: {
                        source: "transport" as const,
                        sentAt: clock.now,
                        contentEvents: 0,
                        reasoningObserved: false,
                        streaming: true,
                      },
                    }
                  : {}),
              })
              await archive({
                type: "response",
                attemptID: secondID,
                status: 200,
                mediaType: "text/event-stream",
                headers: {},
              })
              clock.now = initial + 50_000
              return {
                fullStream: (async function* () {
                  yield { type: "text-start" as const, id: "answer" }
                  clock.now += 20
                  yield { type: "text-delta" as const, id: "answer", text: "answer" }
                  yield { type: "text-end" as const, id: "answer" }
                  if (mode === "overlap") await archive({ type: "attempt-end", attemptID: firstID, status: "failed" })
                  await archive({ type: "attempt-end", attemptID: secondID, status: "completed" })
                })(),
                usage: Promise.resolve(undefined),
                async dispose() {},
              }
            },
          ),
        )
        try {
          await current.processor.process({
            user: current.user,
            sessionID: current.session.id,
            model,
            agent,
            system: [],
            messages: [],
            abort: current.lease.signal,
            toolDefinitions: [],
            executionTools: {},
            executorKinds: {},
          })
          expect(current.processor.message.error).toBeUndefined()
          const rows = ObservabilityStore.queryMetrics({ since: initial, sessionID: current.session.id }).filter(
            (row) =>
              row.name.startsWith("llm.stream.first_content") || row.name.startsWith("llm.stream.first_visible_text"),
          )
          const names = ["llm.stream.first_content", "llm.stream.first_visible_text"]
          expect(rows.map((row) => row.name).sort()).toEqual(
            mode === "timed" ? names : names.map((name) => `${name}.unavailable`),
          )
          expect(rows.map((row) => row.value)).toEqual(mode === "timed" ? [5020, 5020] : [1, 1])
          if (mode !== "timed")
            expect(
              rows.every(
                (row) =>
                  JSON.parse(row.labels_json).reason ===
                  (mode === "overlap" ? "attempt_ambiguous" : "dispatch_unknown"),
              ),
            ).toBe(true)
        } finally {
          await SessionManager.release(current.lease, { requestNextWork: false })
        }
      }),
    ),
)

test.each(["settled", "orphan"] as const)("ignored %s tool frames do not manufacture model progress", (mode) =>
  runtime.run(() =>
    fixture(async (clock) => {
      const current = await turn()
      const resolved = await tools(current)
      let effects = 0
      execute = async () => {
        effects++
      }
      if (mode === "settled")
        await current.processor.executeToolCall({
          callID: "settled-probe",
          toolName: probe.id,
          args: {},
          tool: resolved.executionTools[probe.id],
        })
      const openedAt = clock.now
      spyOn(AgentTurn, "stream").mockResolvedValue({
        fullStream: (async function* () {
          yield { type: "start" as const }
          clock.now += 31_000
          if (mode === "settled") yield { type: "tool-input-start" as const, id: "settled-probe", toolName: probe.id }
          else yield { type: "tool-input-delta" as const, id: "orphan", delta: "{}" }
          clock.now += 31_000
          yield { type: "tool-input-delta" as const, id: mode === "settled" ? "settled-probe" : "orphan", delta: "{}" }
          clock.now += 31_000
          if (mode === "settled")
            yield { type: "tool-call" as const, toolCallId: "settled-probe", toolName: probe.id, input: {} }
          else yield { type: "tool-input-delta" as const, id: "orphan", delta: "{}" }
        })(),
        usage: Promise.resolve(undefined),
        async dispose() {},
      })
      try {
        await current.processor.process({
          user: current.user,
          sessionID: current.session.id,
          model,
          agent,
          system: [],
          messages: [],
          abort: current.lease.signal,
          toolDefinitions: resolved.definitions,
          executionTools: resolved.executionTools,
          executorKinds: resolved.executorKinds,
        })
        expect(current.processor.message.error).toBeUndefined()
        expect(effects).toBe(mode === "settled" ? 1 : 0)
        const span = ObservabilityStore.querySpans({ sessionID: current.session.id }).find(
          (row) => row.name === "llm.request",
        )!
        expect(span.last_activity_time).toBe(openedAt)
        expect(span.heartbeat_count).toBe(3)
        expect(
          ObservabilityStore.queryMetrics({ since: openedAt, sessionID: current.session.id }).filter(
            (row) => row.name.startsWith("llm.stream.first_content") || row.name === "llm.stream.first_token",
          ),
        ).toEqual([])
      } finally {
        await SessionManager.release(current.lease, { requestNextWork: false })
      }
    }),
  ),
)

test("a silent physical owner is alive without output; its confirmed loss plus no progress is diagnosable", () =>
  runtime.run(() =>
    fixture(async (clock) => {
      const current = await turn()
      const resolved = await tools(current)
      execute = async (ctx) => {
        const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] })
        const exited = once(child, "exit")
        await once(child, "spawn")
        const processRecord = ProcessRegistry.create({ command: "silent fixture" })
        processRecord.child = child
        processRecord.pid = child.pid
        const evidence = await ctx.openProcessEvidence!(processRecord.id)
        try {
          const lastProgress = inflight(current.session.id).last_activity_time
          clock.now += 60_000
          const silent = inflight(current.session.id)
          expect(JSON.parse(silent.attributes_json)).toMatchObject({ ownerLiveness: "alive", activityState: "running" })
          expect(silent.last_activity_time).toBe(lastProgress)
          expect(silent.stalled).toBe(0)
          await evidence.append("stdout", new TextEncoder().encode("compiled a unit"))
          expect(inflight(current.session.id).last_activity_time).toBe(clock.now)
          child.kill()
          await exited
          clock.now += 31_000
          expect(inflight(current.session.id).stalled).toBe(1)
          expect(inflight(current.session.id).last_activity_time).toBe(clock.now - 31_000)
          const issue = ObservabilityIssues.list({ module: "tool" }).find((issue) => issue.code === "PERF_TOOL_STALLED")
          expect(issue?.evidence).toMatchObject({ ownerAlive: false, idleMs: 31_000 })
          expect(ObservabilityStore.queryMetrics({ since: 0, names: ["tool.execution.stalled"] })).toHaveLength(1)
        } finally {
          child.kill()
          await exited
          await evidence.finish({ interrupted: true, exitCode: child.exitCode, signal: child.signalCode })
          ProcessRegistry.remove(processRecord.id)
        }
      }
      try {
        await current.processor.executeToolCall({
          callID: "silent-process",
          toolName: probe.id,
          args: {},
          tool: resolved.executionTools[probe.id],
        })
      } finally {
        await SessionManager.release(current.lease, { requestNextWork: false })
      }
    }),
  ))

test("real child-output waiting remains waiting and cancelling that wait does not cancel the child", () =>
  runtime.run(() =>
    fixture(async (clock) => {
      const current = await turn()
      const resolved = await tools(current)
      const child = await Cortex.prepare({
        parentSessionID: current.session.id,
        parentMessageID: current.user.id,
        agent: "developer",
        description: "Queued child",
        prompt: "Wait",
        visibility: "visible",
      })
      const entered = Promise.withResolvers<void>()
      const waitFor = Cortex.waitFor
      using waiting = spyOn(Cortex, "waitFor").mockImplementation((...args) => {
        const result = waitFor(...args)
        entered.resolve()
        return result
      })
      const execution = current.processor.executeToolCall({
        callID: "child-output",
        toolName: TaskOutputTool.id,
        args: { taskId: child.id, block: true },
        tool: resolved.executionTools[TaskOutputTool.id],
      })
      void execution.catch(entered.reject)
      try {
        await entered.promise
        clock.now += 60_000
        const span = inflight(current.session.id)
        expect(JSON.parse(span.attributes_json)).toMatchObject({
          executionPhase: "waiting_background",
          waitReason: "child",
          activityState: "waiting",
        })
        expect(span.stalled).toBe(0)
        SessionManager.signalAbort(current.session.id)
        await expect(execution).rejects.toThrow()
        expect(Cortex.get(child.id)?.status).toBe("queued")
        expect(ObservabilityStore.queryInflight({ sessionID: current.session.id })).toEqual([])
      } finally {
        SessionManager.signalAbort(current.session.id)
        await execution.catch(() => {})
        await SessionManager.release(current.lease, { requestNextWork: false })
        await Cortex.cancel(child.id)
      }
    }),
  ))

test("foreground task uses child waiting through capacity handoff and retains cancellation ownership", () =>
  runtime.run(() =>
    fixture(async (clock) => {
      const current = await turn()
      const resolved = await tools(current)
      let child: Awaited<ReturnType<typeof Cortex.prepare>> | undefined
      const entered = Promise.withResolvers<void>()
      const waitFor = Cortex.waitFor
      const cancel = Cortex.cancel
      const cancelling: Promise<unknown>[] = []
      using cancellation = spyOn(Cortex, "cancel").mockImplementation((...args) => {
        const result = cancel(...args)
        cancelling.push(result)
        return result
      })
      using launch = spyOn(Cortex, "launch").mockImplementation((async (input: Parameters<typeof Cortex.launch>[0]) => {
        child = await Cortex.prepare({ ...input, visibility: "visible" })
        return child
      }) as unknown as typeof Cortex.launch)
      using waiting = spyOn(Cortex, "waitFor").mockImplementation((...args) => {
        const result = waitFor(...args)
        entered.resolve()
        return result
      })
      const execution = current.processor.executeToolCall({
        callID: "foreground-child",
        toolName: TaskTool.id,
        args: {
          taskTitle: "Queued child",
          taskInstructions: "Wait",
          subagent_type: "developer",
          background: false,
        },
        tool: resolved.executionTools[TaskTool.id],
      })
      void execution.catch(entered.reject)
      try {
        await entered.promise
        clock.now += 60_000
        const span = inflight(current.session.id)
        expect(JSON.parse(span.attributes_json)).toMatchObject({
          executionPhase: "waiting_background",
          waitReason: "child",
          activityState: "waiting",
        })
        expect(span.stalled).toBe(0)
        SessionManager.signalAbort(current.session.id)
        await expect(execution).rejects.toThrow()
        await Promise.all(cancelling)
        expect(Cortex.get(child!.id)?.status).toBe("cancelled")
        expect(ObservabilityStore.queryInflight({ sessionID: current.session.id })).toEqual([])
      } finally {
        SessionManager.signalAbort(current.session.id)
        await execution.catch(() => {})
        if (child) await Cortex.cancel(child.id)
        await Promise.allSettled(cancelling)
        await SessionManager.release(current.lease, { requestNextWork: false })
      }
    }),
  ))

test.each(["timeout", "cancel", "root", "generation"] as const)(
  "%s fences late Tool progress without changing terminal settlement",
  (mode) =>
    runtime.run(() =>
      fixture(async (clock) => {
        const current = await turn()
        const resolved = await tools(current)
        const entered = Promise.withResolvers<Tool.Context>()
        const finish = Promise.withResolvers<void>()
        let timeout: (() => void) | undefined
        const nativeTimeout = globalThis.setTimeout
        if (mode === "timeout") {
          const config = await TimeoutConfig.resolve()
          spyOn(TimeoutConfig, "resolve").mockResolvedValue({ ...config, toolOverrides: { [probe.id]: 1234 } })
          spyOn(globalThis, "setTimeout").mockImplementation(((
            action: (...args: unknown[]) => void,
            delay?: number,
            ...args: unknown[]
          ) => {
            if (delay === 1234 && typeof action === "function") timeout = () => action(...args)
            return nativeTimeout(action, delay, ...args)
          }) as typeof setTimeout)
        }
        execute = async (ctx) => {
          entered.resolve(ctx)
          await finish.promise
        }
        const execution = current.processor.executeToolCall({
          callID: `fenced-${mode}`,
          toolName: probe.id,
          args: {},
          tool: resolved.executionTools[probe.id],
        })
        void execution.catch(entered.reject)
        let replacement: SessionManager.LoopLease | undefined
        try {
          const ctx = await entered.promise
          const before = inflight(current.session.id)
          if (mode === "timeout") timeout!()
          if (mode === "cancel") SessionManager.signalAbort(current.session.id)
          if (mode === "root") SessionManager.bindRootTask(current.lease, "replacement-root")
          if (mode === "generation") {
            await SessionManager.release(current.lease, { requestNextWork: false })
            replacement = SessionManager.acquire(current.session.id)!
            SessionManager.bindRootTask(replacement, "replacement-root")
          }
          clock.now += 60_000
          ctx.execution!.progress()
          const stop = ctx.execution!.waiting("child")
          stop()
          ToolResolver.sweepActiveTraces()
          const after = ObservabilityStore.querySpans({ sessionID: current.session.id }).find(
            (span) => span.span_id === before.span_id,
          )!
          expect(after.last_activity_time).toBe(before.last_activity_time)
          expect(after.heartbeat_count).toBe(before.heartbeat_count)
          finish.resolve()
          if (mode === "root") await expect(execution).resolves.toMatchObject({ output: "done" })
          else await expect(execution).rejects.toThrow(mode === "timeout" ? "timed out" : undefined)
          ctx.execution!.progress()
          expect(ObservabilityStore.queryInflight({ sessionID: current.session.id })).toEqual([])
          const terminal = (
            await MessageV2.get({ sessionID: current.session.id, messageID: current.assistant.id })
          ).parts.find((part) => part.type === "tool") as MessageV2.ToolPart
          expect(terminal.state.status).toBe(mode === "root" ? "completed" : "error")
          if (terminal.state.status === "error")
            expect(terminal.state.reason).toBe(mode === "timeout" ? undefined : "cancelled")
        } finally {
          finish.resolve()
          await execution.catch(() => {})
          await SessionManager.release(replacement ?? current.lease, { requestNextWork: false })
        }
      }),
    ),
)
