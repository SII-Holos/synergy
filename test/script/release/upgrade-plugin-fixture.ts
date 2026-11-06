import { definePlugin, operation } from "@ericsanchezok/synergy-plugin"
import { z } from "zod"

export default definePlugin({
  id: "released-upgrade-fixture",
  version: "1.0.0",
  description: "Retained backend plugin acceptance",
  compatibility: { synergy: ">=3.0.22 <4.0.0 || >=0.0.0-0 <0.0.1" },
  contributions: [
    operation({
      id: "echo",
      type: "query",
      expose: ["sdk"],
      input: z.object({ marker: z.string() }),
      output: z.object({ marker: z.string() }),
      handler: async (input) => input,
    }),
  ],
})
