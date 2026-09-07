import { parseToolReviewSource, toolReviewDiffs } from "@/context/tool-review-target"
import { useSDK } from "@/context/sdk"
import { ErrorCard } from "@ericsanchezok/synergy-ui/error-card"
import { Show, createEffect, createMemo, createResource, onCleanup } from "solid-js"
import { useParams } from "@solidjs/router"
import { useLingui } from "@lingui/solid"
import { SessionReviewTab } from "@/components/session"
import { useLayout } from "@/context/layout"
import { useSessionDataView } from "@/context/session-data-view"
import { useSync } from "@/context/sync"
import type { FileDiff, UserMessage } from "@ericsanchezok/synergy-sdk/client"
import type { WorkbenchPanelContentProps } from "@/plugin/registries/workbench-panel-registry"
import { sessionReview as R } from "@/locales/messages"
import { useFile } from "@/context/file"

export function SessionReviewWorkbenchContent(props: WorkbenchPanelContentProps) {
  const params = useParams()
  const sync = useSync()
  const dataView = useSessionDataView()
  const layout = useLayout()
  const file = useFile()
  const lingui = useLingui()
  const sdk = useSDK()
  const toolTarget = createMemo(() => parseToolReviewSource(props.tab.source))
  let controller: AbortController | undefined
  const [toolDiffs, { mutate }] = createResource(toolTarget, async (target) => {
    controller?.abort()
    controller = new AbortController()
    const response = await sdk.client.session.message(
      { sessionID: target.sessionID, messageID: target.messageID },
      { signal: controller.signal, throwOnError: true },
    )
    const part = response.data?.parts.find((part) => part.id === target.partID)
    if (!part || part.type !== "tool")
      throw new Error(
        lingui._({ id: "app.review.toolUnavailable", message: "This tool result is no longer available." }),
      )
    return toolReviewDiffs(part, props.tab.resourceId)
  })
  createEffect(() => {
    if (toolTarget()) return
    controller?.abort()
    mutate(undefined)
  })
  onCleanup(() => controller?.abort())
  const sessionKey = createMemo(() => `${params.dir}${params.id ? "/" + params.id : ""}`)
  const view = createMemo(() => layout.view(sessionKey()))
  const turnDiffs = createMemo(() => {
    const sessionID = params.id
    const messageID = props.tab.source
    if (!sessionID || !messageID || toolTarget()) return undefined
    const message = dataView()
      .messagesFor(sessionID)
      .find((item) => item.id === messageID) as UserMessage | undefined
    return message?.summary?.diffs
  })
  // Explicit exemption: undefined session_diff keeps the "loading" fallback
  // and gates diff fetching below; the view layer's empty array (truthy)
  // would change both semantics.
  const sessionDiffs = createMemo(() => (params.id ? sync.data.session_diff[params.id] : undefined))
  const diffs = createMemo(() =>
    toolTarget() ? (toolDiffs.error || toolDiffs.loading ? undefined : toolDiffs()) : (turnDiffs() ?? sessionDiffs()),
  )
  const selectedFile = createMemo(() => (toolTarget() ? diffs()?.[0]?.file : props.tab.resourceId))

  const loadDiffs = () => {
    const id = params.id
    if (!id || toolTarget()) return
    if (turnDiffs() !== undefined) return
    // Explicit exemption: undefined means "not fetched yet" (same loading
    // gate as above).
    if (sync.data.session_diff[id] !== undefined) return
    void sync.session.diff(id)
  }

  createEffect(loadDiffs)

  return (
    <Show
      when={diffs()}
      fallback={
        <div class="flex h-full items-center justify-center px-6 text-13-regular text-text-weak">
          <Show
            when={toolTarget() && toolDiffs.error}
            fallback={lingui._({ id: R.loading.id, message: R.loading.message })}
          >
            <ErrorCard error={String(toolDiffs.error?.message ?? toolDiffs.error)} />
          </Show>
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
