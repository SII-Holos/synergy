import { createMemo, Show, type ParentProps } from "solid-js"
import { useParams } from "@solidjs/router"
import { SDKProvider, useSDK } from "@/context/sdk"
import { SyncProvider, useSync } from "@/context/sync"
import { LocalProvider } from "@/context/local"
import { FileProvider } from "@/context/file"
import { SessionTransitionProvider } from "@/context/session-transition"

import { base64Decode } from "@ericsanchezok/synergy-util/encode"
import { DataProvider } from "@ericsanchezok/synergy-ui/context"
import { iife } from "@ericsanchezok/synergy-util/iife"
import { useNavigateToSession } from "@/composables/use-navigate-to-session"

export default function Layout(props: ParentProps) {
  const params = useParams()
  const scopeKey = createMemo(() => {
    return base64Decode(params.dir!)
  })
  return (
    <Show when={params.dir} keyed>
      <SDKProvider scopeKey={scopeKey()}>
        <SyncProvider>
          {iife(() => {
            const sync = useSync()
            const sdk = useSDK()
            const navigateToSession = useNavigateToSession()
            const respond = (input: {
              sessionID: string
              permissionID: string
              response: "once" | "session" | "always" | "reject"
            }) => sdk.client.permission.respond(input)

            return (
              <DataProvider
                data={sync.data}
                directory={scopeKey()}
                serverUrl={sdk.url}
                onPermissionRespond={respond}
                onNavigateToSession={navigateToSession}
              >
                <LocalProvider>
                  <SessionTransitionProvider>
                    <FileProvider>{props.children}</FileProvider>
                  </SessionTransitionProvider>
                </LocalProvider>
              </DataProvider>
            )
          })}
        </SyncProvider>
      </SDKProvider>
    </Show>
  )
}
