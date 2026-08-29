import z from "zod"
import { BossService } from "../boss"
import { Tool } from "../../tool/tool"
import DESCRIPTION from "./boss-spawn.txt"

const parameters = z.object({
  role: z.string().min(1).describe("Specialist role label for the worker (e.g. code, review, research)."),
  agent: z.string().optional().describe("Agent to run the worker session. Defaults to the session's agent."),
  instructions: z.string().optional().describe("Optional standing instructions for the worker."),
  workspace: z
    .enum(["main", "worktree"])
    .optional()
    .describe(
      'Where the worker should work: "main" runs in the caller\'s checkout (default), "worktree" creates and binds a fresh git worktree (requires the caller scope to be a Git project).',
    ),
})

export const BossSpawnTool = Tool.define("boss_spawn", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    // Creating a git worktree crosses the workspace boundary; require an
    // explicit permission decision before the worker session is created.
    if (params.workspace === "worktree") {
      await ctx.ask({
        permission: "worktree_enter",
        patterns: ["*"],
        metadata: { reason: "boss_spawn workspace=worktree" },
      })
    }
    const session = await BossService.spawn(ctx.sessionID, params)
    return {
      title: `Worker spawned: ${session.title}`,
      metadata: {
        sessionID: session.id,
        role: params.role,
        agent: session.agentOverride,
        ...(params.workspace ? { workspace: params.workspace } : {}),
      },
      output: `Spawned worker session ${session.id} (${params.role})${params.workspace === "worktree" ? " in a fresh worktree" : ""}. Use boss_assign to hand it a task.`,
    }
  },
})
