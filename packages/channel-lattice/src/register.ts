import { ChannelCommand } from "@ericsanchezok/synergy-channels/channel/command"
import { WorkflowSessionService } from "@ericsanchezok/synergy-lattice/session/workflow"
export function registerBridge() {
  ChannelCommand.register("channel-lattice", [
    {
      name: "lattice",
      triggers: ["/lattice"],
      help: "/lattice [goal] — decompose and execute a larger goal",
      async execute(ctx, scope) {
        return ChannelCommand.changeWorkflow(
          ctx,
          scope,
          "✅ Lattice enabled. Send the goal you want decomposed and executed.",
          async (session) => {
            await WorkflowSessionService.enableLattice(session.id, { kind: "lattice", mode: "auto" })
          },
        )
      },
    },
  ])
}
