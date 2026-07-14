import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ScopeContext } from "../../src/scope/context"
import { PermissionNext } from "../../src/permission/next"
import { ObservabilityStore } from "../../src/observability/store"
import { ObservabilityContext } from "../../src/observability/context"
import { ToolResolver } from "../../src/session/tool-resolver"
import { tmpdir } from "../fixture/fixture"
import { cleanupObservabilityHomes, resetObservabilityHome } from "../observability/fixture"

describe("ToolResolver observability", () => {
  beforeEach(() => resetObservabilityHome("synergy-tool-observability-"))
  afterEach(() => cleanupObservabilityHomes())

  test("repeated tool failures raise one deduped issue without leaking raw input secrets", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const executions = new Map<string, Promise<any>>()
        const processor = minimalProcessor(executions)
        const tools = await ToolResolver.resolveWithAvailability({
          agent: allowAllAgent,
          model,
          sessionID: "ses_tool_obs",
          processor,
          ephemeralTools: [
            {
              id: "ephemeral_fail",
              description: "Always fails",
              inputSchema: { type: "object", properties: { password: { type: "string" } }, additionalProperties: true },
              async execute() {
                throw new Error("provider token 12345 failed")
              },
            },
          ],
          userTools: { ephemeral_fail: true },
          includeMCP: false,
        })

        await expect(
          (tools.tools.ephemeral_fail as any).execute({ password: "plain-secret" }, { toolCallId: "call_fail_a" }),
        ).rejects.toThrow("provider token")
        await expect(
          (tools.tools.ephemeral_fail as any).execute({ password: "plain-secret" }, { toolCallId: "call_fail_b" }),
        ).rejects.toThrow("provider token")

        await executions.get("call_fail_a")
        await executions.get("call_fail_b")
        ObservabilityStore.flush()

        const issues = ObservabilityStore.queryIssues({ status: "open", module: "tool" })
        const issue = issues.find((row) => row.code === "PERF_TOOL_EXECUTION_FAILED")
        expect(issue).toBeDefined()
        expect(issue!.occurrence_count).toBe(2)
        const evidence = JSON.parse(issue!.evidence_json)
        expect(evidence).toMatchObject({ tool: "ephemeral_fail", phase: "tool.execute", errorClass: "Error" })
        expect(evidence.callID).toBe("call_fail_b")
        expect(JSON.stringify(issue)).not.toContain("plain-secret")

        const failureMetrics = ObservabilityStore.queryMetrics({
          since: 0,
          names: ["tool.execution.count", "tool.execution.error"],
          tool: "ephemeral_fail",
        })
        expect(failureMetrics.filter((row) => row.name === "tool.execution.count")).toHaveLength(2)
        expect(failureMetrics.filter((row) => row.name === "tool.execution.error")).toHaveLength(2)
      },
    })
  })

  test("records diagnostic tool calls that fail before executor dispatch", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const executions = new Map<string, Promise<any>>()
        const tools = await ToolResolver.resolveWithAvailability({
          agent: allowAllAgent,
          model,
          sessionID: "ses_tool_diagnostic_obs",
          processor: minimalProcessor(executions),
          ephemeralTools: [
            {
              id: "ephemeral_hidden",
              description: "Hidden for this request",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
              async execute() {
                return { title: "unexpected", output: "unexpected" }
              },
            },
          ],
          userTools: { ephemeral_hidden: false },
          includeMCP: false,
        })

        await expect(
          (tools.tools.ephemeral_hidden as any).execute({}, { toolCallId: "call_diagnostic_hidden" }),
        ).rejects.toThrow("not currently visible")
        await executions.get("call_diagnostic_hidden")
        ObservabilityStore.flush()

        const metrics = ObservabilityStore.queryMetrics({
          since: 0,
          names: ["tool.execution.count", "tool.execution.error"],
          tool: "ephemeral_hidden",
        })
        expect(metrics.filter((row) => row.name === "tool.execution.count")).toHaveLength(1)
        const errors = metrics.filter((row) => row.name === "tool.execution.error")
        expect(errors).toHaveLength(1)
        expect(JSON.parse(errors[0]!.labels_json).errorName).toBe("tool_unavailable")

        const issues = ObservabilityStore.queryIssues({ status: "open", module: "tool", tool: "ephemeral_hidden" })
        expect(issues).toHaveLength(1)
        expect(JSON.parse(issues[0]!.evidence_json)).toMatchObject({
          tool: "ephemeral_hidden",
          phase: "tool.availability",
          errorClass: "tool_unavailable",
          owner: "diagnostic",
          callID: "call_diagnostic_hidden",
        })
      },
    })
  })

  test("keeps concurrent tool heartbeats scoped and linked to their parent traces", async () => {
    await using tmpA = await tmpdir({ git: true })
    await using tmpB = await tmpdir({ git: true })
    const scopeA = await tmpA.scope()
    const scopeB = await tmpB.scope()
    const gateA = deferred<void>()
    const gateB = deferred<void>()

    const start = async (scope: typeof scopeA, id: string, traceId: string, gate: ReturnType<typeof deferred<void>>) =>
      ScopeContext.provide({
        scope,
        fn: () =>
          ObservabilityContext.withContextAsync({ traceId, spanId: `parent_${id}` }, async () => {
            const executions = new Map<string, Promise<any>>()
            const tools = await ToolResolver.resolveWithAvailability({
              agent: allowAllAgent,
              model,
              sessionID: `ses_${id}`,
              processor: minimalProcessor(executions),
              ephemeralTools: [
                {
                  id,
                  description: "Waits for the test gate",
                  inputSchema: { type: "object", properties: {}, additionalProperties: false },
                  async execute() {
                    await gate.promise
                    return { title: id, output: "done" }
                  },
                },
              ],
              userTools: { [id]: true },
              includeMCP: false,
            })
            const execution = (tools.tools[id] as any).execute({}, { toolCallId: `call_${id}` })
            await Bun.sleep(10)
            return { execution, scopeID: scope.id }
          }),
      })

    const [runningA, runningB] = await Promise.all([
      start(scopeA, "ephemeral_scope_a", "trace_shared_turn", gateA),
      start(scopeB, "ephemeral_scope_b", "trace_shared_turn", gateB),
    ])

    try {
      ToolResolver.sweepActiveTraces(Date.now() + 60_000)
      ObservabilityStore.flush()

      const heartbeats = ObservabilityStore.queryEvents({ type: "tool.heartbeat", limit: 10 })
      const stalled = ObservabilityStore.queryEvents({ type: "tool.stalled", limit: 10 })
      expect(new Set(heartbeats.map((event) => event.scope_id))).toEqual(new Set([runningA.scopeID, runningB.scopeID]))
      expect(new Set(stalled.map((event) => event.scope_id))).toEqual(new Set([runningA.scopeID, runningB.scopeID]))
      expect(new Set(heartbeats.map((event) => event.span_id)).size).toBe(2)
      expect(heartbeats.every((event) => event.trace_id === "trace_shared_turn")).toBe(true)

      const spans = ObservabilityStore.queryInflight({ limit: 10 })
      expect(spans.find((span) => span.tool === "ephemeral_scope_a")).toMatchObject({
        trace_id: "trace_shared_turn",
        parent_span_id: "parent_ephemeral_scope_a",
        scope_id: runningA.scopeID,
        stalled: 1,
      })
      expect(spans.find((span) => span.tool === "ephemeral_scope_b")).toMatchObject({
        trace_id: "trace_shared_turn",
        parent_span_id: "parent_ephemeral_scope_b",
        scope_id: runningB.scopeID,
        stalled: 1,
      })
      expect(spans.every((span) => (span.heartbeat_count ?? 0) > 0)).toBe(true)
    } finally {
      gateA.resolve()
      gateB.resolve()
      await Promise.all([runningA.execution, runningB.execution])
    }
  })
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const allowAllAgent = {
  name: "synergy",
  permission: PermissionNext.fromConfig({ "*": "allow" }),
  controlProfile: "full_access",
} as any

const model = {
  id: "test-model",
  modelID: "test-model",
  providerID: "test-provider",
  api: { id: "test-model" },
  capabilities: { input: { image: false } },
} as any

function minimalProcessor(executions: Map<string, Promise<any>>) {
  const callbacks = new Map<string, Promise<unknown>>()
  return {
    message: { id: "msg_tool_obs" },
    partFromToolCall: () => undefined,
    executeOnce: <T>(id: string, execute: () => Promise<T>) => {
      const existing = callbacks.get(id)
      if (existing) return existing as Promise<T>
      const callback = Promise.resolve().then(execute)
      callbacks.set(id, callback)
      return callback
    },
    beginExecution: (id: string) => {
      let outcome: any
      let resolvePromise!: (value: any) => void
      const promise = new Promise<any>((resolve) => {
        resolvePromise = resolve
      })
      executions.set(id, promise)
      return {
        callID: id,
        promise,
        resolve(value: any) {
          if (outcome) return
          outcome = value
          resolvePromise(value)
        },
        complete(input: unknown, result: any) {
          this.resolve({ status: "completed", input, result })
        },
        fail(input: unknown, error: string, metadata?: Record<string, any>) {
          this.resolve({ status: "error", input, error, metadata })
        },
        get outcome() {
          return outcome
        },
        get status() {
          return outcome ? "resolved" : "pending"
        },
      }
    },
  } as any
}
