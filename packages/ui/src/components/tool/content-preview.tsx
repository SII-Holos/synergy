import "./content-preview.css"
import { createMemo, For, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { getFilename, getDirectory } from "@ericsanchezok/synergy-util/path"
import { useReferenceContext, useResourceOpen } from "../../context/resource-open"
import { Button } from "../button"
import { DiffPatch } from "../diff-patch"
import { FileIcon } from "../file-icon"
import { DiffChanges } from "../diff-changes"
import { IconButton } from "../icon-button"
import { getSemanticIcon } from "../semantic-icon"
import { previewToolContent } from "./content-preview-model"
import { toolPatchPreview } from "./patch-preview-model"
import type { ToolProps } from "../tool-registry-lazy"

const truncatedLabel = { id: "ui.toolContent.truncated", message: "Preview shortened." }
const openFileLabel = { id: "ui.toolContent.openFile", message: "Open current file" }
const openReviewLabel = { id: "ui.toolContent.openReview", message: "Open in Review" }

export function ToolFilePreview(props: { content: string; path?: string; offset?: number; limit?: number }) {
  const { _ } = useLingui()
  const resource = useResourceOpen()
  const preview = createMemo(() => previewToolContent(props.content, props))
  const context = useReferenceContext()
  const path = () => props.path
  return (
    <div data-component="tool-content-preview">
      <Show when={preview().truncated}>
        <div>{_(truncatedLabel)}</div>
      </Show>
      <pre data-component="tool-output-text">
        <code>{preview().text}</code>
      </pre>
      <Show when={path()}>
        <Button
          variant="ghost"
          onClick={() =>
            resource?.open({ kind: "workspace-file", path: path()! }, { context: context() ?? { state: "unresolved" } })
          }
        >
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
}) {
  const { _ } = useLingui()
  const resource = useResourceOpen()
  const target = () => {
    const { sessionId, messageId, partId } = props.tool
    if (!sessionId || !messageId || !partId || !resource?.openToolReview) return undefined
    return { sessionID: sessionId, messageID: messageId, partID: partId, path: props.path }
  }
  const preview = createMemo(() => toolPatchPreview(props.patch ?? "", props.path))
  const plain = () => (
    <Show
      when={preview().rows.length}
      fallback={
        <Show
          when={preview().plain}
          fallback={
            <div data-slot="tool-patch-empty">
              {_({ id: "ui.diff.noPreview", message: "No text preview available." })}
            </div>
          }
        >
          {(text) => (
            <pre data-slot="tool-patch-raw">
              <code>{text()}</code>
            </pre>
          )}
        </Show>
      }
    >
      <div data-slot="tool-patch-code">
        <For each={preview().rows}>
          {(row) => (
            <div data-slot="tool-patch-line" data-kind={row.kind} data-gap={row.gap || undefined}>
              <span data-slot="tool-patch-number">{row.number}</span>
              <span data-slot="tool-patch-marker">{row.kind === "add" ? "+" : row.kind === "delete" ? "−" : ""}</span>
              <code>{row.text || "\u00a0"}</code>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
  return (
    <div data-component="tool-patch-preview">
      <div data-slot="tool-patch-header">
        <FileIcon node={{ path: props.path ?? "", type: "file" }} />
        <div data-slot="tool-patch-path" title={props.path}>
          <span data-slot="tool-patch-directory">{getDirectory(props.path ?? "") + "\u200e"}</span>
          <span data-slot="tool-patch-filename">{getFilename(props.path ?? "")}</span>
        </div>
        <Show when={preview().changes}>{(changes) => <DiffChanges changes={changes()} />}</Show>
        <Show when={target()}>
          <IconButton
            icon={getSemanticIcon("command.review")}
            variant="ghost"
            aria-label={_(openReviewLabel)}
            title={_(openReviewLabel)}
            onClick={() => resource?.openToolReview?.(target()!)}
          />
        </Show>
      </div>
      <div data-slot="tool-patch-body">
        <Show when={preview().metadata} fallback={plain()}>
          {(metadata) => (
            <DiffPatch
              patch={props.patch!}
              metadata={metadata()}
              disableLineNumbers={false}
              hunkSeparators="simple"
              renderRange={{ startingLine: 0, totalLines: preview().rows.length, bufferBefore: 0, bufferAfter: 0 }}
              fallback={plain()}
            />
          )}
        </Show>
      </div>
      <Show when={preview().truncated}>
        <div data-slot="tool-patch-empty">{_(truncatedLabel)}</div>
      </Show>
    </div>
  )
}
