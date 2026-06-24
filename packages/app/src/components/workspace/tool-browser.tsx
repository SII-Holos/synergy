import { onMount, onCleanup } from "solid-js"
import { useWorkspace } from "@/context/workspace"
import { BrowserPanel } from "./browser/browser-panel"

/**
 * Registers the Browser workspace tool in the right-side workspace panel.
 * Pattern matches WorkspaceNotesTool.
 */
export function WorkspaceBrowserTool() {
  const workspace = useWorkspace()

  onMount(() => {
    workspace.register({
      id: "browser",
      label: "Browser",
      icon: "globe",
      component: () => <BrowserPanel />,
    })
  })

  onCleanup(() => {
    workspace.unregister("browser")
  })

  return null
}
