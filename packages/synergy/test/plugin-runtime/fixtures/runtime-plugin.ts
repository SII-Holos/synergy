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
      id: "log.details",
      type: "command",
      input: z.object({}),
      output: z.object({ logged: z.boolean() }),
      handler: async (_input, context) => {
        context.log.error("fixture failure", { code: "FIXTURE_ERROR", reason: "expected failure" })
        return { logged: true }
      },
    }),
    operation({
      id: "log.message",
      type: "command",
      input: z.object({}),
      output: z.object({ logged: z.boolean() }),
      handler: async (_input, context) => {
        context.log.info("fixture message")
        return { logged: true }
      },
    }),
    operation({
      id: "runtime.error",
      type: "command",
      input: z.object({}),
      output: z.never(),
      handler: async () => {
        throw Object.assign(new Error("fixture runtime failure"), { code: "FIXTURE_RUNTIME_ERROR" })
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
