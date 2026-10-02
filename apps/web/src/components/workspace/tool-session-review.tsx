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
  const turnMessage = createMemo(() => {
    const sessionID = params.id
    const messageID = props.tab.source
    if (!sessionID || !messageID || toolTarget()) return undefined
    const message = dataView()
      .messagesFor(sessionID)
      .find((item) => item.id === messageID)
    return message?.role === "user" ? message : undefined
  })
  let turnController: AbortController | undefined
  const turnRequest = createMemo(() =>
    params.id && props.tab.source && !toolTarget() && !turnMessage()
      ? { server: sdk.url, scope: sdk.scopeKey, sessionID: params.id, messageID: props.tab.source }
      : undefined,
  )
  const [turnSnapshot] = createResource(turnRequest, async (target) => {
    turnController?.abort()
    const pending = new AbortController()
    turnController = pending
    const response = await sdk.client.session.message(
      { sessionID: target.sessionID, messageID: target.messageID },
      { signal: pending.signal, throwOnError: true },
    )
    if (
      pending.signal.aborted ||
      target.server !== sdk.url ||
      target.scope !== sdk.scopeKey ||
      target.sessionID !== params.id ||
      target.messageID !== props.tab.source
    )
      throw new DOMException("Aborted", "AbortError")
    if (response.data?.info.role !== "user")
      throw new Error(lingui._({ id: "app.review.turnUnavailable", message: "This turn is no longer available." }))
    return { target, message: response.data.info as UserMessage }
  })
  createEffect(() => {
    if (!turnRequest()) turnController?.abort()
  })
  onCleanup(() => turnController?.abort())
  const turnSummary = createMemo(() => {
    const live = turnMessage()
    if (live) return live.summary
    const snapshot = turnSnapshot()
    if (
      snapshot &&
      snapshot.target.server === sdk.url &&
      snapshot.target.scope === sdk.scopeKey &&
      snapshot.target.sessionID === params.id &&
      snapshot.target.messageID === props.tab.source
    )
      return snapshot.message.summary
  })
  const turnDiffs = () => turnSummary()?.diffs
  // Explicit exemption: undefined session_diff keeps the "loading" fallback
  // and gates diff fetching below; the view layer's empty array (truthy)
  // would change both semantics.
  const sessionDiffs = createMemo(() => (params.id ? sync.data.session_diff[params.id] : undefined))
  const diffs = createMemo(() =>
    toolTarget()
      ? toolDiffs.error || toolDiffs.loading
        ? undefined
        : toolDiffs()
      : props.tab.source
        ? turnDiffs()
        : sessionDiffs(),
  )
  const selectedFile = createMemo(() => (toolTarget() ? diffs()?.[0]?.file : props.tab.resourceId))

  const loadDiffs = () => {
    const id = params.id
    if (!id || props.tab.source) return
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
            when={toolDiffs.error || turnSnapshot.error}
            fallback={lingui._({ id: R.loading.id, message: R.loading.message })}
          >
            <ErrorCard
              error={String((toolDiffs.error ?? turnSnapshot.error)?.message ?? toolDiffs.error ?? turnSnapshot.error)}
            />
          </Show>
        </div>
      }
    >
      {(loadedDiffs) => {
        const diffsArr = () => (Array.isArray(loadedDiffs()) ? (loadedDiffs() as FileDiff[]) : ([] as FileDiff[]))
        return (
          <SessionReviewTab
            workspace={() => file.workspace}
            diffs={diffsArr}
            diffState={() => turnSummary()?.diffState}
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
