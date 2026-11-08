export * from "./organization-gen/types.gen.js"
import { createClient } from "./organization-gen/client/client.gen.js"
import type { Config } from "./organization-gen/client/types.gen.js"
import { OrganizationClient } from "./organization-gen/sdk.gen.js"

export { OrganizationClient }
export type { Config as OrganizationClientConfig }

export function createOrganizationClient(config: Config) {
  return new OrganizationClient({ client: createClient(config) })
}
