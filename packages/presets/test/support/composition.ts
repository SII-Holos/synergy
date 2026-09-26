import { migrationFixture } from "@ericsanchezok/synergy-harness/test/migration/fixture"
import { registerFullPreset } from "../../src/registration"
import { registerFullRoutes } from "../../src/server/routes"

export function compositionFixture(options: Parameters<typeof migrationFixture>[0] = {}) {
  return migrationFixture({
    ...options,
    register() {
      registerFullPreset()
      registerFullRoutes()
      options.register?.()
    },
  })
}
