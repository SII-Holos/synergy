import type { DagNode } from "./dag-graph"
import type { ActivityStepProjection } from "./session-turn-activity"
import type { ToolDiffPreviewFileDiff } from "./tool/diff-preview"
import type { TaskSubagentDetailInfo } from "./tool/task-subagent-detail"

export type SpecializedActivityDetail =
  | { kind: "diff"; diff: ToolDiffPreviewFileDiff; patch?: string }
  | { kind: "dag"; nodes: DagNode[]; ready: string[] }
  | { kind: "subagent"; info: TaskSubagentDetailInfo }

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

export function specializedActivityDetail(step: ActivityStepProjection): SpecializedActivityDetail | undefined {
  const state = step.part.state
  const metadata = record(state.metadata)
  if (step.family === "modify-files") {
    const results = Array.isArray(metadata.results) ? metadata.results : []
    const latest = record(results.at(-1))
    const diff = record(metadata.filediff ?? latest.filediff)
    if (Object.keys(diff).length > 0) {
      const patch = metadata.diff ?? latest.diff ?? diff.preview
      return {
        kind: "diff",
        diff: diff as ToolDiffPreviewFileDiff,
        patch: typeof patch === "string" ? patch : undefined,
      }
    }
  }
  if (step.family === "coordination" && step.part.tool.startsWith("dag")) {
    const input = record(state.input)
    const nodes = metadata.nodes ?? input.nodes
    if (Array.isArray(nodes) && nodes.length > 0) {
      const ready = Array.isArray(metadata.ready)
        ? metadata.ready.filter((value): value is string => typeof value === "string")
        : []
      return { kind: "dag", nodes: nodes as DagNode[], ready }
    }
  }
  if (step.family === "delegate" && step.part.tool === "task") {
    const input = record(state.input)
    return {
      kind: "subagent",
      info: {
        agentType: typeof input.subagent_type === "string" ? input.subagent_type : undefined,
        description: typeof input.description === "string" ? input.description : undefined,
        background: metadata.background === true,
        sessionId: typeof metadata.sessionId === "string" ? metadata.sessionId : undefined,
        summary: metadata.summary,
        running: step.state === "running" || step.state === "waiting-approval",
      },
    }
  }
}
