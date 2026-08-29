import { ToolLinkTargetSource } from "../tool/link-target-source"
import type { SynergyLinkTarget } from "./types"
import { SynergyLinkTargetStore } from "./target-store"

/**
 * S9d source inversion: the L1 remote-execution state machine resolves
 * persisted Synergy Link targets and enforces agent access through this
 * registered source. Loaded through src/product-registration.ts.
 */
export function registerToolLinkTargetSource() {
  ToolLinkTargetSource.register({
    requireTarget: (id) => SynergyLinkTargetStore.require(id),
    findRegisteredTarget: (linkID, targetAgentID) => SynergyLinkTargetStore.findByLocator(linkID, targetAgentID),
    assertAgentAccess: (target: SynergyLinkTarget.Info, agent: string) =>
      SynergyLinkTargetStore.assertAgentAccess(target, agent),
  })
}
