import { createMemo, type Accessor } from "solid-js"
import type { CortexTask, PermissionRequest, QuestionRequest, SessionStatus } from "@ericsanchezok/synergy-sdk/client"
import {
  createSessionDataView,
  EMPTY_CORTEX,
  EMPTY_PERMISSIONS,
  EMPTY_QUESTIONS,
  type SessionDataRuntime,
  type SessionDataView,
} from "@ericsanchezok/synergy-ui/context/session-data-view"
import type { PlanBlueprintOfferState } from "./plan-blueprint-offer"
import { useGlobalSync } from "./global-sync"
import { useSync } from "./sync"

export type AppSessionDataView = SessionDataView & {
  planBlueprintOfferFor(sessionID: string): PlanBlueprintOfferState | undefined
}

export type GlobalRuntimeIndex = {
  readonly sessionStatus: Record<string, SessionStatus>
  readonly permissions: Record<string, PermissionRequest[]>
  readonly questions: Record<string, QuestionRequest[]>
  readonly cortex: CortexTask[]
}

/**
 * View accessors over the global runtime index.
 *
 * The accessors read the index at call time so a `createMemo` consumer
 * subscribes to the current bucket: a reconnect reset or a snapshot reconcile
 * replaces the bucket objects, and a captured reference would go stale. A
 * missing key resolves to the shared frozen empty singleton, never a fresh
 * literal, because render chains guard on reference identity.
 */
export function createSessionDataRuntime(globalSync: GlobalRuntimeIndex): SessionDataRuntime {
  return {
    statusFor: (sessionID) => globalSync.sessionStatus[sessionID],
    permissionsFor: (sessionID) => globalSync.permissions[sessionID] ?? EMPTY_PERMISSIONS,
    questionsFor: (sessionID) => globalSync.questions[sessionID] ?? EMPTY_QUESTIONS,
    cortexTasks: () => globalSync.cortex ?? EMPTY_CORTEX,
  }
}

export function useSessionDataView(): Accessor<AppSessionDataView> {
  const sync = useSync()
  const globalSync = useGlobalSync()
  const runtime = createSessionDataRuntime(globalSync)
  return createMemo(() => {
    const view = createSessionDataView(sync.data, runtime)
    return {
      ...view,
      planBlueprintOfferFor: (sessionID) => sync.data.planBlueprintOffer?.[sessionID],
    }
  })
}
