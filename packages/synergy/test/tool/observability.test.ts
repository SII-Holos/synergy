import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ScopeContext } from "../../src/scope/context"
import { PermissionNext } from "../../src/permission/next"
import { ObservabilityStore } from "../../src/observability/store"
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
      },
    })
  })
})

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
  return {
    message: { id: "msg_tool_obs" },
    partFromToolCall: () => undefined,
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
