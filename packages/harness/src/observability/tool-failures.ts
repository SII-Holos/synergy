import { ObservabilityContext } from "./context"
import { ObservabilityIssues } from "./issues"
import { ObservabilityMetrics } from "./metrics"

export namespace ObservabilityToolFailures {
  export type Owner = "builtin" | "mcp" | "ephemeral" | "llm" | "diagnostic"

  export type Input = {
    tool: string
    sessionID: string
    messageID: string
    callID: string
    traceId?: string
    spanId?: string
    scopeID?: string
    phase: string
    error: unknown
    errorClass?: string
    owner: Owner
  }

  export function record(input: Input) {
    const errorClass = classify(input)
    const metric = {
      value: 1,
      unit: "count" as const,
      module: "tool" as const,
      traceId: input.traceId,
      spanId: input.spanId,
      scopeID: input.scopeID,
      sessionID: input.sessionID,
      messageID: input.messageID,
      callID: input.callID,
      tool: input.tool,
    }
    ObservabilityMetrics.record({
      ...metric,
      name: "tool.execution.count",
    })
    ObservabilityMetrics.record({
      ...metric,
      name: "tool.execution.error",
      labels: { errorName: errorClass },
    })
    raiseIssue({ ...input, errorClass })
  }

  export function raiseIssue(input: Input) {
    const errorClass = classify(input)
    const scopeID = input.scopeID ?? ObservabilityContext.current().scopeID
    const signature = [scopeID ?? input.sessionID, input.tool, errorClass, input.phase, input.owner].join(":")
    ObservabilityIssues.raise({
      code: "PERF_TOOL_EXECUTION_FAILED",
      severity: "error",
      module: "tool",
      title: "Tool execution failed",
      message: `${input.tool} failed during ${input.phase}`,
      recommendation: "Inspect the tool trace, failure signature, and permission/sandbox metadata before retrying.",
      traceId: input.traceId,
      spanId: input.spanId,
      scopeID,
      sessionID: input.sessionID,
      messageID: input.messageID,
      callID: input.callID,
      fingerprint: `tool-failure:${signature}`,
      evidence: {
        tool: input.tool,
        phase: input.phase,
        retryable: errorClass !== "PolicyDenied" && errorClass !== "SandboxBlocked" && errorClass !== "BoundaryHit",
        errorClass,
        owner: input.owner,
        callID: input.callID,
      },
    })
  }

  function classify(input: Input) {
    return input.errorClass ?? (input.error instanceof Error ? input.error.name : "UnknownError")
  }
}
