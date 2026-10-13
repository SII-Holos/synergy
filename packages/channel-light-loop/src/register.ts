import { ChannelCommand } from "@ericsanchezok/synergy-channels/channel/command"
import { WorkflowSessionService } from "@ericsanchezok/synergy-light-loop/session/workflow"
export function registerBridge() {
  ChannelCommand.register("channel-light-loop", [
    {
      name: "lightloop",
      triggers: ["/lightloop"],
      help: "/lightloop <task> — keep working until the task passes independent review",
      async execute(ctx, scope) {
        if (!ctx.remainder) return { action: "handled", reply: "Usage: /lightloop <task>" }
        return ChannelCommand.changeWorkflow(ctx, scope, "✅ Light Loop enabled.", async (session) => {
          if (session.workflow?.kind === "lightloop")
            await WorkflowSessionService.updateLightloopInstructions(session.id, ctx.remainder)
          else await WorkflowSessionService.startLightloop(session.id, ctx.remainder)
        })
      },
    },
  ])
}
