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
  ],
})
