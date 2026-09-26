import { migrationFixture } from "@ericsanchezok/synergy-harness/test/migration/fixture"
import { registerProductRuntime } from "../../src/product-registration"
import { registerProductRoutes } from "../../src/server/routes"

export function compositionFixture(options: Parameters<typeof migrationFixture>[0] = {}) {
  return migrationFixture({
    ...options,
    register() {
      registerProductRuntime()
      registerProductRoutes()
      options.register?.()
    },
  })
}
