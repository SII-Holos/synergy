import z from "zod"
import { definePlugin, operation } from "@ericsanchezok/synergy-plugin"

let activations = 0

export default definePlugin({
  id: "runtime-fixture",
  version: "1.0.0",
  description: "Runtime vNext fixture",
  contributions: [
    operation({
      id: "scope.get",
      type: "query",
      input: z.object({}),
      output: z.object({
        scopeId: z.string(),
        activations: z.number(),
        runtime: z.object({
          hostVersion: z.string(),
          pluginVersion: z.string(),
          pluginGeneration: z.string(),
          protocolVersion: z.number(),
        }),
      }),
      handler: async (_input, context) => ({
        scopeId: context.scopeId,
        activations,
        runtime: context.runtime,
      }),
    }),
    operation({
      id: "delay.get",
      type: "query",
      input: z.object({ delayMs: z.number() }),
      output: z.object({ generationScoped: z.boolean() }),
      handler: async (input) => {
        await new Promise((resolve) => setTimeout(resolve, input.delayMs))
        return { generationScoped: true }
      },
    }),
    operation({
      id: "runtime.crash",
      type: "command",
      input: z.object({}),
      output: z.never(),
      handler: async () => {
        process.exit(9)
      },
    }),
  ],
  async activate() {
    activations++
  },
})
