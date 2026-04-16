export * from "./client.js"
export * from "./server.js"

import { createSynergyClient } from "./client.js"
import { createSynergyServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export async function createSynergy(options?: ServerOptions) {
  const server = await createSynergyServer({
    ...options,
  })

  const client = createSynergyClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
