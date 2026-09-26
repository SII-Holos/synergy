export * from "./client.js"
export * from "./server.js"

import { createSynergyClient } from "./client.js"
import { createSynergyServer } from "./server.js"
import type { ServerOptions } from "./server.js"
import { mergeHeaders } from "./gen/client/utils.gen.js"

export async function createSynergy(
  options: ServerOptions & { client?: Omit<NonNullable<Parameters<typeof createSynergyClient>[0]>, "baseUrl"> },
) {
  const server = await createSynergyServer({
    ...options,
  })

  const client = createSynergyClient({
    ...options.client,
    fetch: options.client?.fetch ?? (options.mode === "attach" ? options.fetch : undefined),
    baseUrl: server.url,
    headers: mergeHeaders(options.client?.headers, server.headers),
  })

  return {
    client,
    server,
  }
}
