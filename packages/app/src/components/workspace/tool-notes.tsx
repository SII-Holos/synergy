import { NotePanel } from "@/components/note-panel"
import { registerWorkbenchPanel, type WorkbenchPanelContentProps } from "@/plugin/registries/workbench-panel-registry"
import { onMount, onCleanup } from "solid-js"

function NotesWorkbenchContent(props: WorkbenchPanelContentProps) {
  return <NotePanel tab={props.tab} />
}

export function WorkspaceNotesTool() {
  let unregister: VoidFunction | undefined

  onMount(() => {
    unregister = registerWorkbenchPanel({
      id: "notes",
      label: "Notes",
      icon: "notebook-pen",
      surface: "side",
      cardinality: "singleton",
      pluginId: "builtin",
      order: 10,
      component: NotesWorkbenchContent,
    })
  })

  onCleanup(() => unregister?.())

  return null
}
