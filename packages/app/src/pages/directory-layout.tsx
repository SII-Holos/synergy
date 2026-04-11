import { createMemo, Show, type ParentProps } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { SDKProvider, useSDK } from "@/context/sdk"
import { SyncProvider, useSync } from "@/context/sync"
import { LocalProvider } from "@/context/local"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"

import { base64Decode, base64Encode } from "@ericsanchezok/synergy-util/encode"
import { DataProvider } from "@ericsanchezok/synergy-ui/context"
import { iife } from "@ericsanchezok/synergy-util/iife"

export default function Layout(props: ParentProps) {
  const params = useParams()
  const navigate = useNavigate()
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const directory = createMemo(() => {
    return base64Decode(params.dir!)
  })
  return (
    <Show when={params.dir} keyed>
      <SDKProvider directory={directory()}>
        <SyncProvider>
          {iife(() => {
            const sync = useSync()
            const sdk = useSDK()
            const respond = (input: { sessionID: string; permissionID: string; response: "once" | "reject" }) =>
              sdk.client.permission.respond(input)

            const routeDir = (scope: { type?: string; directory?: string }) =>
              base64Encode(scope.type === "global" ? "global" : (scope.directory ?? directory()))

            const navigateToSession = (sessionID: string) => {
              const navState = { state: { from: window.location.pathname } }

              const localMatch = sync.data.session.find((s) => s.id === sessionID)
              if (localMatch) {
                navigate(`/${routeDir(localMatch.scope)}/session/${sessionID}`, navState)
                return
              }

              for (const scope of globalSync.data.scope) {
                const [store] = globalSync.child(scope.worktree)
                const match = store.session.find((s) => s.id === sessionID)
                if (match) {
                  navigate(`/${routeDir(match.scope)}/session/${sessionID}`, navState)
                  return
                }
              }

              globalSDK.client.session
                .get({ sessionID })
                .then((res) => {
                  const session = res.data
                  if (session) {
                    navigate(`/${routeDir(session.scope)}/session/${sessionID}`, navState)
                  } else {
                    navigate(`/${params.dir}/session/${sessionID}`, navState)
                  }
                })
                .catch(() => {
                  navigate(`/${params.dir}/session/${sessionID}`, navState)
                })
            }

            return (
              <DataProvider
                data={sync.data}
                directory={directory()}
                serverUrl={sdk.url}
                onPermissionRespond={respond}
                onNavigateToSession={navigateToSession}
              >
                <LocalProvider>{props.children}</LocalProvider>
              </DataProvider>
            )
          })}
        </SyncProvider>
      </SDKProvider>
    </Show>
  )
}
