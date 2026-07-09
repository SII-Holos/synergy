import { Show, createEffect, createMemo, onCleanup, onMount } from "solid-js"
import { useParams } from "@solidjs/router"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { SessionReviewTab } from "@/components/session"
import { useFile } from "@/context/file"
import { useLayout } from "@/context/layout"
import { useSync } from "@/context/sync"
import { registerWorkbenchPanel, type WorkbenchPanelContentProps } from "@/plugin/registries/workbench-panel-registry"

function SessionReviewWorkbenchContent(props: WorkbenchPanelContentProps) {
  const params = useParams()
  const sync = useSync()
  const layout = useLayout()
  const file = useFile()
  const sessionKey = createMemo(() => `${params.dir}${params.id ? "/" + params.id : ""}`)
  const tabs = createMemo(() => layout.tabs(sessionKey()))
  const view = createMemo(() => layout.view(sessionKey()))
  const diffs = createMemo(() => (params.id ? sync.data.session_diff[params.id] : undefined))
  const selectedFile = createMemo(() => props.tab.resourceId)

  const loadDiffs = () => {
    const id = params.id
    if (!id) return
    if (sync.data.session_diff[id] !== undefined) return
    void sync.session.diff(id)
  }

  createEffect(loadDiffs)

  return (
    <Show
      when={diffs()}
      fallback={
        <div class="flex h-full items-center justify-center px-6 text-13-regular text-text-weak">Loading changes…</div>
      }
    >
      {(loadedDiffs) => (
        <SessionReviewTab
          diffs={() => loadedDiffs()}
          view={view}
          diffStyle={layout.review.diffStyle()}
          onDiffStyleChange={layout.review.setDiffStyle}
          selectedFile={selectedFile}
          onViewFile={(path) => {
            const value = file.tab(path)
            tabs().open(value)
            file.load(path)
          }}
        />
      )}
    </Show>
  )
}

export function WorkspaceSessionReviewTool() {
  let unregister: VoidFunction | undefined

  onMount(() => {
    unregister = registerWorkbenchPanel({
      id: "session-review",
      label: "Review",
      icon: getSemanticIcon("command.review"),
      surface: "side",
      cardinality: "singleton",
      requiresSession: true,
      pluginId: "builtin",
      order: 15,
      component: SessionReviewWorkbenchContent,
      title: () => "Review",
    })
  })

  onCleanup(() => unregister?.())

  return null
}
