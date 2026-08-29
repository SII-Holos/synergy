import { SessionBlueprintState } from "../session/blueprint-state"
import { BlueprintLoopStore, isActiveLoopStatus } from "./loop-store"
import { buildBlueprintLoopContext } from "./prompt"
import type { Info as BlueprintLoopInfo } from "./types"

/**
 * S9c source inversion: the L1 session domain reaches blueprint loop state
 * (store access, active-status semantics, loop prompt context) through the
 * SessionBlueprintState registry instead of importing the blueprint product
 * domain. Loaded through src/product-registration.ts.
 */
export function registerBlueprintSessionState() {
  SessionBlueprintState.register({
    get: (scopeID, loopID) => BlueprintLoopStore.get(scopeID, loopID).catch(() => undefined),
    list: (scopeID) => BlueprintLoopStore.list(scopeID),
    updateStatus: (scopeID, loopID, patch) => BlueprintLoopStore.updateStatus(scopeID, loopID, patch),
    isActiveStatus: (status) => isActiveLoopStatus(status),
    buildLoopContext: (input) =>
      buildBlueprintLoopContext({
        loop: input.loop as BlueprintLoopInfo,
        isAuditSession: input.isAuditSession,
        agentName: input.agentName,
      }),
  })
}
