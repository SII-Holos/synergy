import { definePlugin, lifecycleUpgrade } from "@ericsanchezok/synergy-plugin"

export default definePlugin({
  id: "runtime-fixture",
  version: "2.0.0",
  description: "Failing upgrade fixture",
  contributions: [
    lifecycleUpgrade({
      id: "migrate",
      handler: async () => {
        throw new Error("migration failed")
      },
    }),
  ],
})
