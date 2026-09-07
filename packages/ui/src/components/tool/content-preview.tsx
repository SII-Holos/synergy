import "./content-preview.css"
import { createMemo, Show, type JSX } from "solid-js"
import { useLingui } from "@lingui/solid"
import { useResourceOpen } from "../../context/resource-open"
import { Button } from "../button"
import { DiffPreview } from "./diff-preview"
import { previewToolContent } from "./content-preview-model"
import type { ToolProps } from "../tool-registry-lazy"

const truncatedLabel = { id: "ui.toolContent.truncated", message: "Preview shortened." }
const openFileLabel = { id: "ui.toolContent.openFile", message: "Open current file" }
const openReviewLabel = { id: "ui.toolContent.openReview", message: "Open in Review" }

export function ToolFilePreview(props: { content: string; path?: string; offset?: number; limit?: number }) {
  const { _ } = useLingui()
  const resource = useResourceOpen()
  const preview = createMemo(() => previewToolContent(props.content, props))
  const path = () => resource?.resolveWorkspacePath?.(props.path)
  return (
    <div data-component="tool-content-preview">
      <Show when={preview().truncated}>
        <div>{_(truncatedLabel)}</div>
      </Show>
      <pre data-component="tool-output-text">
        <code>{preview().text}</code>
      </pre>
      <Show when={path()}>
        <Button variant="ghost" onClick={() => resource?.openWorkspaceSource?.(path()!)}>
          {_(openFileLabel)}
        </Button>
      </Show>
    </div>
  )
}

export function ToolPatchPreview(props: {
  patch?: string
  path?: string
  tool: Pick<ToolProps, "sessionId" | "messageId" | "partId">
  fallback?: JSX.Element
}) {
  const { _ } = useLingui()
  const resource = useResourceOpen()
  const target = () => {
    const { sessionId, messageId, partId } = props.tool
    if (!sessionId || !messageId || !partId || !resource?.openToolReview) return undefined
    return { sessionID: sessionId, messageID: messageId, partID: partId, path: props.path }
  }
  const preview = createMemo(() => previewToolContent(props.patch ?? ""))
  return (
    <div data-component="tool-content-preview">
      <Show when={props.patch} fallback={props.fallback}>
        <DiffPreview diff={{ file: props.path, preview: preview().text, truncated: preview().truncated }} />
      </Show>
      <Show when={target()}>
        <Button variant="ghost" onClick={() => resource?.openToolReview?.(target()!)}>
          {_(openReviewLabel)}
        </Button>
      </Show>
    </div>
  )
}
