import { SessionInputResources } from "@ericsanchezok/synergy-harness/session/input-source"
import { MCP } from "."

/**
 * S9c source inversion: the L1 session input resolver reads MCP resources
 * through the SessionInputResources registry instead of importing the mcp
 * product domain. Loaded through src/product-registration.ts.
 */
export function registerMcpSessionInput() {
  SessionInputResources.registerMcpResourceReader((clientName, uri) => MCP.readResource(clientName, uri))
}
