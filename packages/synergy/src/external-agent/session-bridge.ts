import { SessionExternalAgents } from "../session/external-agents"
import { ExternalAgent } from "./bridge"
import { ExternalAgentProcessor } from "./processor"

/**
 * S9c source inversion: the L1 session invoke loop drives external-agent
 * adapters through the SessionExternalAgents registry instead of importing
 * the external-agent product domain. Loaded through src/product-registration.ts.
 */
export function registerExternalAgentSessionBridge() {
  SessionExternalAgents.register({
    getAdapter: (name, sessionID) => ExternalAgent.getAdapter(name, sessionID),
    process: (input) =>
      ExternalAgentProcessor.process({
        ...input,
        adapter: input.adapter as unknown as ExternalAgent.Adapter,
      }),
  })
}
