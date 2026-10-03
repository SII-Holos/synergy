import { useLingui } from "@lingui/solid"
import { useWorkbenchPanels } from "@/context/workbench"
import { useSDK } from "@/context/sdk"
import { usePlatform } from "@/context/platform"
import { useParams } from "@solidjs/router"
import { useBrowserCatalog } from "./browser-catalog"
import { createBrowserImportTarget } from "./browser-import-target"
import { browserWorkbenchRoute } from "./browser-workbench-model"
import { BrowserImportDialog, importUnavailable, importTargetClosed } from "./browser-import-entry"
import type { WorkbenchPanelTab } from "@/plugin/registries/workbench-panel-registry"

export function useBrowserImportEntry(tab: () => WorkbenchPanelTab) {
  const workbench = useWorkbenchPanels(),
    sdk = useSDK(),
    platform = usePlatform(),
    catalog = useBrowserCatalog(),
    params = useParams()
  const { _ } = useLingui()
  return () => {
    const source = tab(),
      opening = workbench.openingForTab(source.id)
    const serverUrl = sdk.url,
      session = workbench.sessionKey()
    const resolveTarget = createBrowserImportTarget({
      tab: source,
      route: browserWorkbenchRoute(source.state) ?? {
        mode: "scope",
        scopeID: sdk.scopeID,
        path_directory: params.dir ?? sdk.scopeID ?? sdk.scopeKey,
      },
      client: sdk.client,
      serverUrl,
      catalog,
      bridge: () => platform.browserNative,
      current: () => sdk.url === serverUrl && workbench.sessionKey() === session,
      resolveTab: opening?.resolve,
      unavailable: _(importUnavailable),
      closed: _(importTargetClosed),
    })
    workbench.showDialog(() => <BrowserImportDialog resolveTarget={resolveTarget} />)
  }
}
