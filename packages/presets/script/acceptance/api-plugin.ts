import { z } from "zod"
import { definePlugin, tool } from "@ericsanchezok/synergy-plugin"

export default definePlugin({
  id: "acceptance-api",
  version: "1.0.0",
  description: "Isolated acceptance business API",
  contributions: [
    tool({
      id: "record",
      description: "Read an acceptance business record using its loopback URL.",
      requiresWorkspace: false,
      exposure: { mode: "resident" },
      input: z.object({ url: z.url() }),
      async handler(input, context) {
        if (new URL(input.url).hostname !== "127.0.0.1") throw new Error("Acceptance fixture only accepts loopback")
        const response = await fetch(input.url, {
          signal: context.signal,
          headers: { "x-acceptance-entry": "plugin", "x-acceptance-pid": String(process.pid) },
        })
        if (!response.ok) throw new Error(`Acceptance API returned ${response.status}`)
        return { title: "Business record", output: await response.text(), metadata: {} }
      },
    }),
  ],
})
