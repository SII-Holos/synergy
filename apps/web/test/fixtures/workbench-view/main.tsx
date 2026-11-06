import { render } from "solid-js/web"
import { createEffect, onCleanup, Show } from "solid-js"
import { I18nProvider } from "@lingui/solid"
import { DialogProvider, useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { useResourceOpen } from "@ericsanchezok/synergy-ui/context/resource-open"
import { GlobalSDKProvider, useGlobalSDK } from "../../../src/context/global-sdk"
import { WorkbenchPanelsProvider, useWorkbenchPanels } from "../../../src/context/workbench"
import { ResourceOpenProvider } from "../../../src/context/resource-open"
import { FileProvider, useFile } from "../../../src/context/file"
import { WorkbenchSurface } from "../../../src/components/workspace/workbench-surface"
import { registerWorkbenchPanel } from "../../../src/plugin/registries/workbench-panel-registry"
import { ViewActivityProvider } from "../../../src/context/view-residency"
import {
  controls,
  attachSDK,
  attachWorkbench,
  session,
  active,
  mounted,
  i18n,
  effects,
  events,
  catalog,
  route,
} from "./services"

function Document(props: { tab: { panelId: string; resourceId?: string } }) {
  const file = useFile()
  const text = () => {
    const content = file.get("one.ts")?.content
    return file.draft.get("one.ts")?.content ?? (content?.kind === "text" ? content.content : "")
  }
  return (
    <div data-testid="document" data-resource={props.tab.resourceId}>
      <p>
        {props.tab.panelId}:{props.tab.resourceId}
      </p>
      <Show when={props.tab.panelId === "file"}>
        <textarea
          aria-label="File draft"
          value={text()}
          onInput={(event) => file.draft.update("one.ts", event.currentTarget.value)}
        />
      </Show>
    </div>
  )
}
for (const id of ["notes", "file", "attachment", "browser"])
  registerWorkbenchPanel({
    id,
    label: id,
    icon: "file",
    surface: "side",
    cardinality: "multi",
    pluginId: "builtin",
    component: Document,
    ...(id === "browser"
      ? {
          createTab() {
            effects.push("create-page")
            throw new Error("No bare Browser opens")
          },
          resolveTab(init) {
            const page = catalog.session.pages.find((page) => page.id === init.resourceId)
            return page
              ? { ...init, source: JSON.stringify([route.serverUrl, route.ownerKey]), state: { browserRoute: route } }
              : undefined
          },
        }
      : {}),
  })
function Controls() {
  const resources = useResourceOpen()!
  const file = useFile()
  const dialog = useDialog()
  Object.assign(controls, {
    open: resources.open,
    draft: () => file.draft.get("one.ts"),
    showDialog: () =>
      dialog.show(() => (
        <Dialog title="Protected dialog">
          <input aria-label="Dialog draft" />
        </Dialog>
      )),
    closeDialog: () => dialog.close(),
  })
  return (
    <div data-ui-part="session" style="display:flex;height:700px">
      <div class="session-workbench-pane">
        <textarea aria-label="Composer" />
      </div>
      <WorkbenchSurface surface="side" />
    </div>
  )
}
function Owned() {
  attachWorkbench(useWorkbenchPanels())
  return (
    <FileProvider>
      <ResourceOpenProvider>
        <Controls />
      </ResourceOpenProvider>
    </FileProvider>
  )
}
function App() {
  const sdk = useGlobalSDK()
  attachSDK(sdk)
  createEffect(() => sdk.content.active("scope", active() ? session() : undefined))
  onCleanup(sdk.event.listen(({ details }) => events.push(details.type)))
  return (
    <ViewActivityProvider active={active}>
      <Show when={mounted()}>
        <WorkbenchPanelsProvider>
          <Owned />
        </WorkbenchPanelsProvider>
      </Show>
    </ViewActivityProvider>
  )
}
Object.assign(window, { fixture: controls })
render(
  () => (
    <I18nProvider i18n={i18n}>
      <DialogProvider>
        <GlobalSDKProvider>
          <App />
        </GlobalSDKProvider>
      </DialogProvider>
    </I18nProvider>
  ),
  document.getElementById("root")!,
)
