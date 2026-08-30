import z from "zod"
import { BossService } from "../boss"
import { Tool } from "../../tool/tool"
import DESCRIPTION from "./boss-status.txt"

function renderTree(node: BossService.BossTreeNode, indent: string): string[] {
  const task = node.currentTask
    ? ` — task ${node.currentTask.taskID}${node.currentTask.taskTitle ? `: ${node.currentTask.taskTitle}` : ""}`
    : ""
  const role = node.role === "boss" ? "boss" : `worker(${node.workerRole ?? "?"})`
  const agent = node.agent ? ` [${node.agent}]` : ""
  const lines = [`${indent}- [${node.status}] ${node.title} (${role}${agent}, ${node.sessionID})${task}`]
  for (const child of node.children) lines.push(...renderTree(child, `${indent}  `))
  return lines
}

const parameters = z.object({
  depth: z.number().int().min(0).optional().describe("Maximum tree depth to render. Default 16."),
})

export const BossStatusTool = Tool.define("boss_status", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const tree = await BossService.status(ctx.sessionID, { depth: params.depth })
    const lines = renderTree(tree, "")
    const workerCount = countWorkers(tree)
    return {
      title: `Boss tree (${workerCount} workers)`,
      metadata: { rootSessionID: tree.sessionID, workerCount },
      output: lines.join("\n"),
    }
  },
})

function countWorkers(node: BossService.BossTreeNode): number {
  let count = node.role === "worker" ? 1 : 0
  for (const child of node.children) count += countWorkers(child)
  return count
}
