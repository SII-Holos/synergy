import { NotePanel } from "@/components/note-panel"
import { registerWorkbenchPanel } from "@/plugin/registries/workbench-panel-registry"
import { onMount, onCleanup } from "solid-js"

export function WorkspaceNotesTool() {
  let unregister: VoidFunction | undefined

  onMount(() => {
    unregister = registerWorkbenchPanel({
      id: "notes",
      label: "Notes",
      icon: "notebook-pen",
      surface: "side",
      cardinality: "exclusive",
      pluginId: "builtin",
      order: 10,
      component: () => <NotePanel />,
    })
  })

  onCleanup(() => unregister?.())

  return null
}
