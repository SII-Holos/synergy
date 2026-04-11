import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION_WRITE from "./dagwrite.txt"
import DESCRIPTION_READ from "./dagread.txt"
import DESCRIPTION_PATCH from "./dagpatch.txt"
import { Dag } from "../session/dag"

function buildExecutionHint(nodes: Dag.Node[], ready: string[]): string {
  const running = nodes.filter((n) => n.status === "running")
  if (running.length === 0) return ""

  const parts: string[] = []

  if (running.length >= 2) {
    const assignments = running
      .map((n) => `"${n.id}"${n.assign && n.assign !== "self" ? ` (${n.assign})` : ""}`)
      .join(", ")
    parts.push(
      `> ${running.length} nodes are now running: ${assignments}`,
      `> These nodes have no unmet dependencies — consider dispatching them in parallel via task(background=true, dag_node_id="<id>") to maximize throughput.`,
    )
  }

  if (parts.length > 0) {
    parts.unshift("")
  }

  return parts.join("\n")
}

export const DagWriteTool = Tool.define("dagwrite", {
  description: DESCRIPTION_WRITE,
  parameters: z.object({
    nodes: z.array(z.object(Dag.Node.shape)).describe("The complete DAG node list"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "dagwrite",
      patterns: ["*"],
      metadata: {},
    })

    const previous = await Dag.get(ctx.sessionID)
    const validation = Dag.validate(params.nodes, previous.length > 0 ? previous : undefined)

    if (!validation.valid) {
      const feedback = [
        `DAG validation failed with ${validation.errors.length} error(s):`,
        ...validation.errors.map((e) => `  ERROR: ${e}`),
        ...(validation.fixes.length > 0
          ? ["", `Auto-fixed ${validation.fixes.length} issue(s):`, ...validation.fixes.map((f) => `  FIX: ${f}`)]
          : []),
        ...(validation.warnings.length > 0
          ? ["", `${validation.warnings.length} warning(s):`, ...validation.warnings.map((w) => `  WARN: ${w}`)]
          : []),
        "",
        "Please fix the errors and try again.",
      ].join("\n")

      return {
        title: "Invalid DAG",
        output: feedback,
        metadata: { nodes: params.nodes, ready: [] },
      }
    }

    const nodes = validation.nodes
    const promoted = Dag.autoPromote(nodes)
    const ready = Dag.computeReady(nodes)
    await Dag.update({ sessionID: ctx.sessionID, nodes })

    const completed = nodes.filter((n) => n.status === "completed").length
    const total = nodes.length

    const parts: string[] = []

    if (validation.fixes.length > 0) {
      parts.push(`Auto-fixed ${validation.fixes.length} issue(s):`)
      parts.push(...validation.fixes.map((f) => `  FIX: ${f}`))
      parts.push("")
    }
    if (promoted.length > 0) {
      parts.push(`Auto-promoted ${promoted.length} node(s) to running: ${promoted.join(", ")}`)
      parts.push("")
    }
    if (validation.warnings.length > 0) {
      parts.push(`${validation.warnings.length} warning(s):`)
      parts.push(...validation.warnings.map((w) => `  WARN: ${w}`))
      parts.push("")
    }
    parts.push(JSON.stringify({ nodes, ready }, null, 2))
    parts.push(buildExecutionHint(nodes, ready))

    return {
      title: `${completed}/${total} done`,
      output: parts.join("\n"),
      metadata: { nodes, ready },
    }
  },
})

export const DagReadTool = Tool.define("dagread", {
  description: DESCRIPTION_READ,
  parameters: z.object({}),
  async execute(_params, ctx) {
    await ctx.ask({
      permission: "dagread",
      patterns: ["*"],
      metadata: {},
    })

    const nodes = await Dag.get(ctx.sessionID)
    Dag.autoPromote(nodes)
    const ready = Dag.computeReady(nodes)

    const completed = nodes.filter((n) => n.status === "completed").length
    const total = nodes.length

    return {
      title: total > 0 ? `${completed}/${total} done` : "empty",
      output: JSON.stringify({ nodes, ready }, null, 2) + buildExecutionHint(nodes, ready),
      metadata: { nodes, ready },
    }
  },
})

export const DagPatchTool = Tool.define("dagpatch", {
  description: DESCRIPTION_PATCH,
  parameters: z.object({
    nodes: z
      .array(
        z.object({
          id: z.string().describe("Node ID to update"),
          status: z.string().describe("New status: completed, failed, cancelled, or pending (for retry)"),
        }),
      )
      .describe("Nodes to update"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "dagwrite",
      patterns: ["*"],
      metadata: {},
    })

    const nodes = await Dag.get(ctx.sessionID)
    if (nodes.length === 0) {
      return {
        title: "No DAG",
        output: "No DAG exists for this session. Use dagwrite to create one first.",
        metadata: { nodes: [], ready: [] },
      }
    }

    const nodeMap = new Map(nodes.map((n) => [n.id, n]))
    const updates: string[] = []
    const errors: string[] = []

    for (const patch of params.nodes) {
      const node = nodeMap.get(patch.id)
      if (!node) {
        errors.push(`Node "${patch.id}" not found`)
        continue
      }
      if (!new Set<string>(Dag.VALID_STATUSES).has(patch.status)) {
        errors.push(`Invalid status "${patch.status}" for node "${patch.id}"`)
        continue
      }
      const prev = node.status
      node.status = patch.status as Dag.Status
      updates.push(`${patch.id}: ${prev} → ${patch.status}`)
    }

    if (errors.length > 0 && updates.length === 0) {
      return {
        title: "Patch failed",
        output: errors.map((e) => `ERROR: ${e}`).join("\n"),
        metadata: { nodes, ready: [] },
      }
    }

    const promoted = Dag.autoPromote(nodes)
    const ready = Dag.computeReady(nodes)
    await Dag.update({ sessionID: ctx.sessionID, nodes })

    const completed = nodes.filter((n) => n.status === "completed").length
    const total = nodes.length

    const parts: string[] = []
    parts.push(`Updated ${updates.length} node(s): ${updates.join("; ")}`)
    if (promoted.length > 0) {
      parts.push(`Auto-promoted to running: ${promoted.join(", ")}`)
    }
    if (errors.length > 0) {
      parts.push(`${errors.length} error(s): ${errors.join("; ")}`)
    }
    parts.push("")
    parts.push(JSON.stringify({ nodes, ready }, null, 2))
    parts.push(buildExecutionHint(nodes, ready))

    return {
      title: `${completed}/${total} done`,
      output: parts.join("\n"),
      metadata: { nodes, ready },
    }
  },
})
