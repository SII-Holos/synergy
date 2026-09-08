import z from "zod"
import { capability, definePlugin, operation } from "@ericsanchezok/synergy-plugin"

export default definePlugin({
  id: "endpoint-filter-fixture",
  version: "1.0.0",
  description: "Runtime endpoint capability filter fixture",
  capabilities: [capability("runtime.endpoint.read")],
  contributions: [
    operation({
      id: "endpoint.declared",
      type: "query",
      input: z.object({}),
      output: z.object({ hasEndpoint: z.boolean() }),
      requires: ["runtime.endpoint.read"],
      handler: async (_input, context) => ({ hasEndpoint: Boolean(context.runtimeEndpoint) }),
    }),
    operation({
      id: "endpoint.undeclared",
      type: "query",
      input: z.object({}),
      output: z.object({ hasEndpoint: z.boolean() }),
      handler: async (_input, context) => ({ hasEndpoint: Boolean(context.runtimeEndpoint) }),
    }),
  ],
})
