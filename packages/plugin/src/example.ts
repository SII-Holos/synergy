import z from "zod"
import { capability, definePlugin, event, operation } from "./index.js"

export default definePlugin({
  id: "example",
  version: "1.0.0",
  description: "Minimal Synergy Plugin API example",
  capabilities: [capability("workspace.read")],
  contributions: [
    event({ id: "example.changed", payload: z.object({ value: z.string() }) }),
    operation({
      id: "example.get",
      type: "query",
      requires: ["workspace.read"],
      input: z.object({}),
      output: z.object({ value: z.string() }),
      async handler(_input, context) {
        return { value: (await context.workspace?.read?.("example.txt")) ?? "" }
      },
    }),
  ],
})
