import { z } from "zod"
import { capability, definePlugin, operation } from "@ericsanchezok/synergy-plugin"

export default definePlugin({
  id: "workspace-runtime-fixture",
  version: "1.0.0",
  description: "Workspace invocation ownership fixture",
  capabilities: [capability("workspace.read"), capability("workspace.write"), capability("shell.execute")],
  contributions: [
    operation({
      id: "transform",
      type: "command",
      requires: ["workspace.read", "workspace.write", "shell.execute"],
      input: z.object({ path: z.string(), command: z.array(z.string()).min(1) }),
      output: z.object({ before: z.string(), after: z.string(), exitCode: z.number() }),
      async handler(input, context) {
        const before = await context.workspace!.read!(input.path)
        const execution = await context.shell!.run({ command: input.command as [string, ...string[]] })
        const after = await context.workspace!.read!(input.path)
        await context.workspace!.write!(input.path, `${after}:plugin`)
        return { before, after: await context.workspace!.read!(input.path), exitCode: execution.exitCode }
      },
    }),
    operation({
      id: "edit",
      type: "command",
      requires: ["workspace.read", "workspace.write"],
      input: z.object({ path: z.string(), content: z.string() }),
      output: z.object({ before: z.string(), after: z.string() }),
      async handler(input, context) {
        const before = await context.workspace!.read!(input.path)
        await context.workspace!.write!(input.path, input.content)
        return { before, after: await context.workspace!.read!(input.path) }
      },
    }),
    operation({
      id: "unjoined",
      type: "command",
      requires: ["workspace.read", "workspace.write"],
      input: z.object({ path: z.string(), content: z.string() }),
      output: z.null(),
      async handler(input, context) {
        void context.workspace!.write!(input.path, input.content).catch(() => {})
        await context.workspace!.metadata!()
        return null
      },
    }),
    operation({
      id: "write",
      type: "command",
      requires: ["workspace.write"],
      input: z.object({ path: z.string(), content: z.string() }),
      output: z.null(),
      async handler(input, context) {
        await context.workspace!.write!(input.path, input.content)
        return null
      },
    }),
  ],
})
