import type { PluginComposerLayoutService } from "@ericsanchezok/synergy-plugin"
import type { PluginConversationService } from "@ericsanchezok/synergy-plugin"
import { HostView } from "./host-view"
import { createMemo, createSignal, onCleanup, type Component, type JSX } from "solid-js"
import { ShellSurface } from "./shell-surface"
import type {
  PluginShellService,
  PluginPageId,
  PluginHostViewId,
  PluginInputService,
  PluginSessionService,
  PluginSessionLayoutService,
  PluginWorkbenchService,
} from "@ericsanchezok/synergy-plugin"
import { DefaultShell } from "./default-shell"
import { usePluginHost } from "./host"
import {
  getShell,
  registerShell,
  subscribeShells,
  type ShellEntry,
  type ShellRenderProps,
} from "./registries/shell-registry"

const DefaultShellMount: Component<ShellRenderProps> = (props) => <DefaultShell context={{ shell: props.shell }} />
const builtin: ShellEntry = {
  id: "synergy",
  label: "Synergy",
  slot: "app.shell",
  order: 0,
  loader: async () => ({ default: DefaultShellMount }),
}
registerShell(builtin)

function selectedShell() {
  const host = usePluginHost()
  const [revision, setRevision] = createSignal(0)
  onCleanup(subscribeShells(() => setRevision((value) => value + 1)))
  return createMemo(() => {
    revision()
    return (host.safeUI ? undefined : getShell(host.shell.current())) ?? builtin
  })
}

export function ShellOutlet(props: { shell: PluginShellService; workbench: PluginWorkbenchService }) {
  const host = usePluginHost()
  const entry = selectedShell()
  return (
    <ShellSurface
      requireOutlets
      reportError={(error) => {
        host.reportError(error)
        if (entry().pluginId) host.shell.failed(entry().id)
      }}
      entry={entry()}
      loader={entry().loader}
      workbench={props.workbench}
      shell={props.shell}
      fallback={DefaultShellMount}
    />
  )
}

export function PluginPageOutlet(props: {
  page: PluginPageId
  sessionId?: string
  input?: PluginInputService
  session?: PluginSessionService
  conversation?: PluginConversationService
  composerLayout?: PluginComposerLayoutService
  workbench?: PluginWorkbenchService
  layout?: PluginSessionLayoutService
  fallback: () => JSX.Element
  views?: Partial<Record<PluginHostViewId, () => JSX.Element>>
}) {
  const host = usePluginHost()
  const entry = selectedShell()
  const Fallback: Component<ShellRenderProps> = () => props.fallback()
  const fallbackLoader: ShellEntry["loader"] = async () => ({ default: Fallback })
  const shell: PluginShellService = {
    page: () => props.page,
    render(view) {
      if (view === "route") return <HostView render={props.fallback} />
      const render = props.views?.[view]
      if (!render) throw new Error(`Host view ${view} is not available on ${props.page}`)
      return <HostView render={render} />
    },
  }
  return (
    <ShellSurface
      reportError={host.reportError}
      entry={entry()}
      loader={entry().pages?.[props.page] ?? fallbackLoader}
      shell={shell}
      sessionId={props.sessionId}
      input={props.input}
      session={props.session}
      conversation={props.conversation}
      composerLayout={props.composerLayout}
      layout={props.layout}
      workbench={props.workbench}
      fallback={Fallback}
    />
  )
}
