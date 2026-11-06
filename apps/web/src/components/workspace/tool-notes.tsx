import { NotePanel } from "@/components/note"
import type { WorkbenchPanelContentProps } from "@/plugin/registries/workbench-panel-registry"

export function NotesWorkbenchContent(props: WorkbenchPanelContentProps) {
  return <NotePanel tab={props.tab} />
}
