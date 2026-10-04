import { parseToolReviewSource, toolReviewDiffs } from "@/context/tool-review-target"
import { useSDK } from "@/context/sdk"
import { ErrorCard } from "@ericsanchezok/synergy-ui/error-card"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Show, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { useParams } from "@solidjs/router"
import { useLingui } from "@lingui/solid"
import { SessionReviewTab } from "@/components/session"
import { useLayout } from "@/context/layout"
import type { WorkbenchPanelContentProps } from "@/plugin/registries/workbench-panel-registry"
import { panels, sessionReview as R } from "@/locales/messages"
import { useFile } from "@/context/file"
import { ReviewPanel } from "./review-panel"
import { reviewCopy as C } from "./review-copy"

export function SessionReviewWorkbenchContent(props: WorkbenchPanelContentProps) {
  return (
    <Show when={parseToolReviewSource(props.tab.source)} fallback={<ReviewPanel {...props} />}>
      <ToolReviewContent {...props} />
    </Show>
  )
}

function ToolReviewContent(props: WorkbenchPanelContentProps) {
  const params = useParams(),
    layout = useLayout(),
    file = useFile(),
    lingui = useLingui(),
    sdk = useSDK()
  const key = createMemo(() =>
    JSON.stringify([sdk.url, sdk.scopeKey, params.id, props.tab.source, props.tab.resourceId]),
  )
  let controller: AbortController | undefined
  const [accepted, setAccepted] = createSignal<{ key: string; diffs: ReturnType<typeof toolReviewDiffs> }>()
  const [toolDiffs, { refetch }] = createResource(key, async (captured) => {
    controller?.abort()
    controller = new AbortController()
    const signal = controller.signal,
      target = parseToolReviewSource(props.tab.source)
    if (!target || target.sessionID !== params.id) throw new Error(lingui._(C.turnUnavailable))
    const response = await sdk.client.session.message(
      { sessionID: target.sessionID, messageID: target.messageID },
      { signal, throwOnError: true },
    )
    if (signal.aborted || captured !== key()) throw new DOMException("Aborted", "AbortError")
    const part = response.data?.parts.find((part) => part.id === target.partID)
    if (!part || part.type !== "tool")
      throw new Error(
        lingui._({ id: "app.review.toolUnavailable", message: "This tool result is no longer available." }),
      )
    const value = { key: captured, diffs: toolReviewDiffs(part, props.tab.resourceId) }
    setAccepted(value)
    return value
  })
  onCleanup(() => controller?.abort())
  const view = createMemo(() => layout.view(`${params.dir}/${params.id}`))
  const diffs = () => (accepted()?.key === key() ? accepted()!.diffs : undefined)
  return (
    <Show
      when={diffs()}
      fallback={
        <div class="flex h-full flex-col items-center justify-center gap-3 px-6 text-13-regular text-text-weak">
          <Show when={toolDiffs.error} fallback={lingui._({ id: R.loading.id, message: R.loading.message })}>
            <ErrorCard error={String(toolDiffs.error?.message ?? toolDiffs.error)} />
            <Button variant="ghost" onClick={() => void refetch()}>
              {lingui._(C.retry)}
            </Button>
          </Show>
        </div>
      }
    >
      {(rows) => (
        <SessionReviewTab
          workspace={() => file.workspace}
          diffs={rows}
          title={lingui._(panels.review)}
          view={view}
          diffStyle={layout.review.diffStyle()}
          onDiffStyleChange={layout.review.setDiffStyle}
          selectedFile={() => rows()[0]?.file}
          onViewFile={(path) => void file.openWorkspaceFile(path)}
        />
      )}
    </Show>
  )
}
