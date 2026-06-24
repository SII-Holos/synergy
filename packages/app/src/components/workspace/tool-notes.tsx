import { NotePanel } from "@/components/note-panel"
import { useWorkspace } from "@/context/workspace"
import { onMount, onCleanup } from "solid-js"

export function WorkspaceNotesTool() {
  const workspace = useWorkspace()

  onMount(() => {
    workspace.register({
      id: "notes",
      label: "Notes",
      icon: "notebook-pen",
      component: () => <NotePanel />,
    })
  })

  onCleanup(() => workspace.unregister("notes"))

  return null
}
