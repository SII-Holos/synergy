import { onMount, onCleanup } from "solid-js"
import { registerWorkbenchPanel } from "@/plugin/registries/workbench-panel-registry"
import { BrowserPanel } from "./browser/browser-panel"

/**
 * Registers the Browser tool in the right-side workbench surface.
 * Pattern matches WorkspaceNotesTool.
 */
export function WorkspaceBrowserTool() {
  let unregister: VoidFunction | undefined

  onMount(() => {
    unregister = registerWorkbenchPanel({
      id: "browser",
      label: "Browser",
      icon: "globe",
      surface: "side",
      cardinality: "singleton",
      requiresSession: true,
      pluginId: "builtin",
      order: 20,
      component: () => <BrowserPanel />,
    })
  })

  onCleanup(() => {
    unregister?.()
  })

  return null
}
