import { z } from "zod"
import { capability, definePlugin, operation, tool } from "@ericsanchezok/synergy-plugin"

export default definePlugin({
  id: "origin-runtime-fixture",
  version: "1.0.0",
  description: "Native invocation origin fixture",
  capabilities: [capability("workspace.read")],
  contributions: [
    tool({
      id: "read",
      description: "Read a selected file",
      requiresWorkspace: false,
      requires: ["workspace.read"],
      input: z.object({ path: z.string() }),
      handler: (input, context) => context.workspace!.read!(input.path),
    }),
    operation({
      id: "read",
      type: "command",
      requires: ["workspace.read"],
      input: z.object({ path: z.string() }),
      output: z.string(),
      handler: (input, context) => context.workspace!.read!(input.path),
    }),
  ],
})
