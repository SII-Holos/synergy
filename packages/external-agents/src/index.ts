export { ExternalAgent } from "./bridge"
export { ExternalAgentDiscovery } from "./discovery"
export { ExternalAgentProcessor } from "./processor"

import { registerAdapter as registerCodex } from "./adapter/codex"
import { registerAdapter as registerClaude } from "./adapter/claude-code"
import { registerAdapter as registerOpenClaw } from "./adapter/openclaw"
export function registerExternalAdapters() {
  registerCodex()
  registerClaude()
  registerOpenClaw()
}
