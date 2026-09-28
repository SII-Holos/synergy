import { z } from "zod"
import { capability, definePlugin, operation } from "@ericsanchezok/synergy-plugin"

export default definePlugin({
  id: "acceptance-files",
  version: "1.0.0",
  description: "Isolated file view and delayed write acceptance",
  capabilities: [capability("workspace.read"), capability("workspace.write")],
  contributions: [
    operation({
      id: "edit",
      type: "command",
      requires: ["workspace.read", "workspace.write"],
      input: z.object({ path: z.string(), content: z.string(), barrier: z.url().optional() }),
      output: z.object({ before: z.string(), after: z.string(), pid: z.number() }),
      async handler(input, context) {
        const before = await context.workspace!.read!(input.path)
        if (input.barrier) {
          if (new URL(input.barrier).hostname !== "127.0.0.1") throw new Error("Barrier must be loopback")
          const reply = await fetch(input.barrier, {
            method: "POST",
            body: JSON.stringify({ before, pid: process.pid }),
            signal: context.signal,
          })
          if (!reply.ok) throw new Error("Acceptance barrier rejected")
        }
        await context.workspace!.write!(input.path, input.content)
        return { before, after: await context.workspace!.read!(input.path), pid: process.pid }
      },
    }),
  ],
})
