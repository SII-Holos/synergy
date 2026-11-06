import { ChannelCommand } from "@ericsanchezok/synergy-channels/channel/command"
import { WorkflowSessionService } from "@ericsanchezok/synergy-blueprint/session/workflow"
export function registerBridge() {
  ChannelCommand.register("channel-blueprint", [
    {
      name: "plan",
      triggers: ["/blueprint", "/plan"],
      help: "/blueprint [request] (/plan) — use Plan to author a Blueprint",
      async execute(ctx, scope) {
        return ChannelCommand.changeWorkflow(
          ctx,
          scope,
          "✅ Blueprint planning enabled. Send the request you want turned into a Blueprint.",
          async (session) => {
            if (session.workflow?.kind !== "plan") await WorkflowSessionService.enablePlan(session.id)
          },
        )
      },
    },
  ])
}
