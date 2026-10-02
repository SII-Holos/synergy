import { createMemo, Show, type ParentProps } from "solid-js"
import { useParams } from "@solidjs/router"
import { SDKProvider, useSDK } from "@/context/sdk"
import { SyncProvider, useSync } from "@/context/sync"
import { LocalProvider } from "@/context/local"
import { FileProvider } from "@/context/file"
import { ExecutionProvider } from "@/context/execution"
import { BrowserCatalogProvider } from "@/components/workspace/browser/browser-catalog"
import { useGlobalSync } from "@/context/global-sync"
import { createSessionDataRuntime } from "@/context/session-data-view"

import { base64Decode } from "@ericsanchezok/synergy-util/encode"
import { DataProvider } from "@ericsanchezok/synergy-ui/context"
import { iife } from "@ericsanchezok/synergy-util/iife"
import { useNavigateToSession } from "@/composables/use-navigate-to-session"
import { SessionDecisionProvider, useSessionDecision } from "@/context/session-decision"

export default function Layout(props: ParentProps) {
  const params = useParams()
  const scopeKey = createMemo(() => {
    return base64Decode(params.dir!)
  })
  return (
    <Show when={params.dir} keyed>
      <SDKProvider scopeKey={scopeKey()}>
        <SyncProvider>
          <SessionDecisionProvider>
            {iife(() => {
              const sync = useSync()
              const sdk = useSDK()
              const globalSync = useGlobalSync()
              const decisions = useSessionDecision()
              const navigateToSession = useNavigateToSession()
              const respond = (input: {
                sessionID: string
                permissionID: string
                response: "once" | "session" | "always" | "reject"
              }) => {
                void decisions.respondPermission({ id: input.permissionID, sessionID: input.sessionID }, input.response)
              }

              return (
                <DataProvider
                  data={sync.data}
                  runtime={createSessionDataRuntime(globalSync)}
                  directory={
                    params.id ? (sync.session.get(params.id)?.workspace?.path ?? null) : sync.data.path.directory
                  }
                  serverUrl={sdk.url}
                  onPermissionRespond={respond}
                  onNavigateToSession={navigateToSession}
                >
                  <ExecutionProvider>
                    <LocalProvider>
                      <FileProvider>
                        <BrowserCatalogProvider>{props.children}</BrowserCatalogProvider>
                      </FileProvider>
                    </LocalProvider>
                  </ExecutionProvider>
                </DataProvider>
              )
            })}
          </SessionDecisionProvider>
        </SyncProvider>
      </SDKProvider>
    </Show>
  )
}
