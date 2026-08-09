import z from "zod"
import { BossService } from "../session/boss"
import { Tool } from "./tool"
import DESCRIPTION from "./boss-spawn.txt"

const parameters = z.object({
  role: z.string().min(1).describe("Specialist role label for the worker (e.g. code, review, research)."),
  agent: z.string().optional().describe("Agent to run the worker session. Defaults to the session's agent."),
  instructions: z.string().optional().describe("Optional standing instructions for the worker."),
})

export const BossSpawnTool = Tool.define("boss_spawn", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const session = await BossService.spawn(ctx.sessionID, params)
    return {
      title: `Worker spawned: ${session.title}`,
      metadata: { sessionID: session.id, role: params.role, agent: session.agentOverride },
      output: `Spawned worker session ${session.id} (${params.role}). Use boss_assign to hand it a task.`,
    }
  },
})
