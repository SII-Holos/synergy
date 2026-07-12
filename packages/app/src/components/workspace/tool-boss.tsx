import { useParams } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { useGlobalSync } from "@/context/global-sync"
import { BossPanel, type BossPanelSDK } from "@/components/boss/boss-panel"
import type { WorkbenchPanelContentProps } from "@/plugin/registries/workbench-panel-registry"

export function BossWorkbenchContent(_props: WorkbenchPanelContentProps) {
  const sdk = useSDK()
  const params = useParams()
  const globalSync = useGlobalSync()
  return (
    <BossPanel
      sdk={sdk as unknown as BossPanelSDK}
      sessionID={params.id}
      reconnectVersion={globalSync.reconnectVersion()}
    />
  )
}
