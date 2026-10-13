import { useGlobalSync } from "@/context/global-sync"
import { useViewResidency } from "@/context/view-residency"
import { lazy, Suspense, onCleanup, createSignal } from "solid-js"
import { useParams, useNavigate } from "@solidjs/router"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePluginHost } from "@/plugin/host"
import { SessionRouteProvider } from "@/context/session-route"
import { WorkbenchPanelRegistryProvider } from "@/context/workbench/registry"
import { WorkbenchPanelsProvider } from "@/context/workbench"
import { RetainedSessionViews } from "@/components/session/retained-session-views"
import { base64Decode, base64Encode } from "@ericsanchezok/synergy-util/encode"
import DirectoryLayout from "./directory-layout"

const Session = lazy(async () => {
  const module = await import("./session")
  window.dispatchEvent(new Event("synergy:app-surface-ready"))
  return module
})
export default function SessionRoute() {
  const budget = useViewResidency()
  const sync = useGlobalSync()
  onCleanup(
    sync.contentBudget.onPressure(() => {
      budget?.panels.evictInactive()
      budget?.sessions.evictInactive()
    }),
  )
  const params = useParams()
  const sdk = useGlobalSDK()
  const plugins = usePluginHost()
  const navigate = useNavigate()
  const [invalidated, invalidate] = createSignal<{ scopeID: string; sessionID: string }>()
  onCleanup(
    sdk.event.listen(({ name, details }) => {
      if (details.type !== "session.deleted") return
      const sessionID = details.properties.info.id
      invalidate({ scopeID: name, sessionID })
      if (base64Decode(params.dir!) === name && params.id === sessionID)
        navigate(`/${params.dir}/session`, { replace: true })
    }),
  )
  return (
    <RetainedSessionViews
      invalidated={invalidated()}
      owner={{
        server: sdk.url,
        scopeID: base64Decode(params.dir!),
        sessionID: params.id ?? "",
        generation: plugins.scopeGeneration(base64Decode(params.dir!)),
      }}
      render={(owner) => (
        <SessionRouteProvider params={{ dir: base64Encode(owner.scopeID), id: owner.sessionID || undefined }}>
          <WorkbenchPanelRegistryProvider>
            <WorkbenchPanelsProvider>
              <DirectoryLayout>
                <Suspense>
                  <Session />
                </Suspense>
              </DirectoryLayout>
            </WorkbenchPanelsProvider>
          </WorkbenchPanelRegistryProvider>
        </SessionRouteProvider>
      )}
    />
  )
}
