import { z } from "zod"
import { capability, definePlugin, operation } from "@ericsanchezok/synergy-plugin"

export default definePlugin({
  id: "host-connection-fixture",
  version: "1.0.0",
  description: "Host connection process fixture",
  capabilities: [capability("host.connection.manage")],
  contributions: [
    operation({
      id: "invite",
      type: "command",
      requires: ["host.connection.manage"],
      input: z.object({}),
      output: z.object({ code: z.string(), expiresAt: z.number() }),
      async handler(_input, context) {
        return context.hostConnection!.invite()
      },
    }),
    operation({
      id: "configure",
      type: "command",
      requires: ["host.connection.manage"],
      input: z.object({ wait: z.boolean() }),
      output: z.unknown(),
      async handler(input, context) {
        if (input.wait) await context.hostConnection!.pending()
        return context.hostConnection!.configure({ enabled: true, name: "Fixture" })
      },
    }),
    ...(["approve", "finish"] as const).map((method) =>
      operation({
        id: method,
        type: "command",
        requires: ["host.connection.manage"],
        input: z.object({ requestID: z.string() }),
        output: z.unknown(),
        async handler(input, context) {
          return context.hostConnection![method](input)
        },
      }),
    ),
  ],
})
