import { Bus } from "@/bus"
import { CommandSourceProviders } from "../instruction/source-provider"
import { MCP } from "./index"

/**
 * H7 source inversion: the command domain consumes MCP prompts through the
 * L1 CommandSourceProviders registry, so command no longer imports the mcp
 * domain and the product layer stays acyclic. The MCP change events that
 * used to be subscribed inside command.ts are owned by this provider.
 */
export function registerMcpCommandSource() {
  CommandSourceProviders.register("mcp", {
    prompts: () => MCP.prompts(),
    getPrompt: async (clientName, name, args) => {
      const template = await MCP.getPrompt(clientName, name, args)
      return (
        template?.messages.map((message) => (message.content.type === "text" ? message.content.text : "")).join("\n") ||
        ""
      )
    },
    subscribe: (change) => {
      const unsubscribers = [
        Bus.subscribe(MCP.ToolsChanged, change),
        Bus.subscribe(MCP.PromptsChanged, change),
        Bus.subscribe(MCP.Ready, change),
      ]
      return () => {
        for (const unsubscribe of unsubscribers) unsubscribe()
      }
    },
  })
}
