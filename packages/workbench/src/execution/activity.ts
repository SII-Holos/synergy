import type { ExecutionSchema } from "./schema"

export namespace ExecutionActivity {
  export type Segment = { runID: string | null; from: number; to: number; count: number; rounds: number }
  export function project(rows: readonly ExecutionSchema.Node[], root: string) {
    const byID = new Map(rows.map((node) => [node.id, node]))
    const requests = new Set(rows.filter((node) => node.evidenceKind === "attempt").map((node) => node.parentID))
    const instructions = new Set(
      rows.filter((node) => node.kind === "subtask").map((node) => node.sessionID + ":" + node.runID),
    )
    const nodes = rows
      .filter(
        (node) =>
          node.kind === "subtask" ||
          node.kind === "tool" ||
          (node.kind === "input" &&
            (node.sessionID === root || !instructions.has(node.sessionID + ":" + node.runID))) ||
          node.evidenceKind === "attempt" ||
          (node.evidenceKind === "call" && !requests.has(node.id)),
      )
      .map((node, index) => ({
        ...node,
        activity: {
          index,
          count: 1,
          endIndex: index,
          instruction: node.kind === "subtask" || (node.kind === "input" && node.sessionID !== root),
        },
      }))
    const segments: Segment[] = []
    for (const node of nodes) {
      let ancestor: ExecutionSchema.Node | undefined = node
      const seen = new Set<string>()
      while (ancestor && ancestor.sessionID !== root && ancestor.parentID && !seen.has(ancestor.id)) {
        seen.add(ancestor.id)
        ancestor = byID.get(ancestor.parentID)
      }
      const runID = ancestor?.sessionID === root ? ancestor.runID : null
      const last = segments.at(-1)
      if (last?.runID === runID) {
        last.to = node.activity.index
        last.count++
      } else segments.push({ runID, from: node.activity.index, to: node.activity.index, count: 1, rounds: 1 })
    }
    const chunks: Segment[] = []
    const size = Math.max(1, Math.ceil(segments.length / 160))
    for (let index = 0; index < segments.length; index += size) {
      const values = segments.slice(index, index + size)
      chunks.push({
        runID: values.length === 1 ? values[0].runID : null,
        from: values[0].from,
        to: values.at(-1)!.to,
        count: values.reduce((sum, value) => sum + value.count, 0),
        rounds: new Set(values.map((value) => value.runID)).size,
      })
    }
    return {
      nodes,
      segments: chunks,
      humanInputs: nodes.filter((node) => node.kind === "input" && !node.activity.instruction).length,
      taskInstructions: nodes.filter((node) => node.activity.instruction).length,
    }
  }
  export function aggregate(nodes: ReturnType<typeof project>["nodes"], kind: "input" | "model" | "tool") {
    const lane = nodes.filter((node) =>
      kind === "input"
        ? node.kind === "input" || node.kind === "subtask"
        : kind === "model"
          ? node.evidenceKind === "call" || node.evidenceKind === "attempt"
          : node.kind === "tool",
    )
    const size = Math.max(1, Math.ceil(lane.length / 160))
    const result = []
    for (let index = 0; index < lane.length; index += size) {
      const bucket = lane.slice(index, index + size)
      result.push({
        ...bucket[0],
        activity: { ...bucket[0].activity, count: bucket.length, endIndex: bucket.at(-1)!.activity.index },
      })
    }
    return result
  }
}
