import { Show, createEffect, createMemo } from "solid-js"
import { useParams } from "@solidjs/router"
import { useLingui } from "@lingui/solid"
import { SessionReviewTab } from "@/components/session"
import { useLayout } from "@/context/layout"
import { useSync } from "@/context/sync"
import type { FileDiff, UserMessage } from "@ericsanchezok/synergy-sdk/client"
import type { WorkbenchPanelContentProps } from "@/plugin/registries/workbench-panel-registry"
import { sessionReview as R } from "@/locales/messages"
import { useFile } from "@/context/file"

export function SessionReviewWorkbenchContent(props: WorkbenchPanelContentProps) {
  const params = useParams()
  const sync = useSync()
  const layout = useLayout()
  const file = useFile()
  const lingui = useLingui()
  const sessionKey = createMemo(() => `${params.dir}${params.id ? "/" + params.id : ""}`)
  const view = createMemo(() => layout.view(sessionKey()))
  const turnDiffs = createMemo(() => {
    const sessionID = params.id
    const messageID = props.tab.source
    if (!sessionID || !messageID) return undefined
    const message = sync.data.message[sessionID]?.find((item) => item.id === messageID) as UserMessage | undefined
    return message?.summary?.diffs
  })
  const sessionDiffs = createMemo(() => (params.id ? sync.data.session_diff[params.id] : undefined))
  const diffs = createMemo(() => turnDiffs() ?? sessionDiffs())
  const selectedFile = createMemo(() => props.tab.resourceId)

  const loadDiffs = () => {
    const id = params.id
    if (!id) return
    if (turnDiffs() !== undefined) return
    if (sync.data.session_diff[id] !== undefined) return
    void sync.session.diff(id)
  }

  createEffect(loadDiffs)

  return (
    <Show
      when={diffs()}
      fallback={
        <div class="flex h-full items-center justify-center px-6 text-13-regular text-text-weak">
          {lingui._({ id: R.loading.id, message: R.loading.message })}
        </div>
      }
    >
      {(loadedDiffs) => {
        const diffsArr = () => (Array.isArray(loadedDiffs()) ? (loadedDiffs() as FileDiff[]) : ([] as FileDiff[]))
        return (
          <SessionReviewTab
            diffs={diffsArr}
            view={view}
            diffStyle={layout.review.diffStyle()}
            onDiffStyleChange={layout.review.setDiffStyle}
            selectedFile={selectedFile}
            onViewFile={(path) => void file.openWorkspaceFile(path)}
          />
        )
      }}
    </Show>
  )
}
