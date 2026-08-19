import { createMemo, type Accessor } from "solid-js"
import { createSessionDataView, type SessionDataView } from "@ericsanchezok/synergy-ui/context/session-data-view"
import type { PlanBlueprintOfferState } from "./plan-blueprint-offer"
import { useSync } from "./sync"

export type AppSessionDataView = SessionDataView & {
  planBlueprintOfferFor(sessionID: string): PlanBlueprintOfferState | undefined
}

export function useSessionDataView(): Accessor<AppSessionDataView> {
  const sync = useSync()
  return createMemo(() => {
    const view = createSessionDataView(sync.data)
    return {
      ...view,
      planBlueprintOfferFor: (sessionID) => sync.data.planBlueprintOffer?.[sessionID],
    }
  })
}
