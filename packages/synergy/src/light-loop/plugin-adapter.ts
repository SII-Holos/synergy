import { LightLoopRuntime } from "./runtime"
import { LightLoopTerminalStore } from "./terminal-hook"

/**
 * Plugin host-service adapter for the LightLoop domain (mirrors the blueprint
 * slot in plugin/host-services.ts). The object stays structurally typed: the
 * light-loop domain must not import plugin (that product→product pair is not
 * in the R3 snapshot; the registration happens on the plugin side, which owns
 * the allowed plugin→light-loop direction).
 */
export const lightLoopPluginAdapter = {
  scheduleDeadline(sessionID: string, deadlineAt: number) {
    LightLoopRuntime.scheduleDeadline(sessionID, deadlineAt)
  },
  setTerminalStatus(
    sessionID: string,
    status: Parameters<typeof LightLoopRuntime.setTerminalStatus>[1],
    error?: string,
  ) {
    return LightLoopRuntime.setTerminalStatus(sessionID, status, error)
  },
  getTerminal(session: Parameters<typeof LightLoopTerminalStore.get>[0]) {
    return LightLoopTerminalStore.get(session)
  },
}
