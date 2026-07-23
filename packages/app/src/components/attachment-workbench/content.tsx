import { createMemo, createResource, createSignal, Match, Show, Switch } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { AttachmentPart, Part } from "@ericsanchezok/synergy-sdk"
import {
  attachmentSourcePath,
  formatAttachmentSize,
  resolveAttachmentUrl,
} from "@ericsanchezok/synergy-ui/attachment-card"
import { FileIcon } from "@ericsanchezok/synergy-ui/file-icon"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Markdown } from "@ericsanchezok/synergy-ui/markdown"
import { RenderHtml } from "@ericsanchezok/synergy-ui/render-html"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useData } from "@ericsanchezok/synergy-ui/context/data"
import { useFile } from "@/context/file"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import type { WorkbenchPanelContentProps } from "@/plugin/registries/workbench-panel-registry"
import { attachmentWorkbench as A } from "@/locales/messages"
import { panels as P } from "@/locales/messages"
import { FileSourceView } from "@/components/file-workbench/source-view"
import {
  AttachmentTooLargeError,
  attachmentResourceState,
  classifyAttachmentPreview,
  fetchAttachmentBytes,
  findAttachmentByLocator,
} from "./model"
import { AttachmentPdfPreview } from "./pdf-preview"
import { sanitizeAttachmentHtml } from "./html"
import "./styles.css"

function attachmentBytes(attachment: AttachmentPart) {
  const metadata = attachment.metadata?.attachment as Record<string, unknown> | undefined
  return typeof metadata?.size === "number" ? metadata.size : undefined
}

export function AttachmentWorkbenchContent(props: WorkbenchPanelContentProps) {
  const lingui = useLingui()
  const data = useData()
  const file = useFile()
  const platform = usePlatform()
  const sdk = useSDK()
  const locator = createMemo(() => attachmentResourceState(props.tab.state))
  const local = createMemo(() => {
    const value = locator()
    return value ? findAttachmentByLocator(data.store.part[value.messageID], value) : undefined
  })
  const [remoteParts] = createResource(
    () => {
      const value = locator()
      return value && !local() ? value : undefined
    },
    async (value) => {
      const response = await sdk.client.session.message({
        sessionID: value.sessionID,
        messageID: value.messageID,
      })
      return response.data?.parts as Part[] | undefined
    },
  )
  const attachment = createMemo(() => {
    const value = locator()
    return local() ?? (value ? findAttachmentByLocator(remoteParts(), value) : undefined)
  })
  const capability = createMemo(() => {
    const value = attachment()
    return value ? classifyAttachmentPreview(value.mime, value.filename) : undefined
  })
  const [mode, setMode] = createSignal<"preview" | "source">("preview")
  const [mediaFailed, setMediaFailed] = createSignal(false)
  const url = createMemo(() => {
    const value = attachment()
    return value ? resolveAttachmentUrl(sdk.url, value) : undefined
  })
  const sourcePath = createMemo(() => {
    const value = attachment()
    return value ? file.normalize(attachmentSourcePath(value) ?? "") : undefined
  })
  const previewRequest = createMemo(() => {
    const value = attachment()
    const preview = capability()
    const href = url()
    if (!value || !preview?.maxBytes || !href) return undefined
    const size = attachmentBytes(value)
    if (size !== undefined && size > preview.maxBytes) {
      return { href, maxBytes: preview.maxBytes, tooLarge: true as const }
    }
    return { href, maxBytes: preview.maxBytes, tooLarge: false as const }
  })
  const [payload] = createResource(
    () => {
      const request = previewRequest()
      return request && !request.tooLarge ? request : undefined
    },
    async (request) => fetchAttachmentBytes(platform.fetch ?? fetch, request.href, request.maxBytes),
  )
  const text = createMemo(() => {
    const bytes = payload()
    return bytes ? new TextDecoder().decode(bytes) : undefined
  })
  const previewError = createMemo(() => {
    if (previewRequest()?.tooLarge) return "too-large" as const
    const cause = payload.error
    if (cause instanceof AttachmentTooLargeError) return "too-large" as const
    return cause ? ("failed" as const) : undefined
  })

  const displayMode = createMemo(() => {
    const preview = capability()
    if (!preview) return "preview"
    if (!preview.dual) return preview.defaultMode
    return mode()
  })

  return (
    <div class="attachment-workbench">
      <Show
        when={attachment()}
        fallback={
          <div class="attachment-workbench-state">
            <Show when={remoteParts.loading} fallback={<Icon name={getSemanticIcon("state.warning")} size="normal" />}>
              <Spinner class="size-5" />
            </Show>
            <strong>{remoteParts.loading ? lingui._(A.loading) : lingui._(A.unavailable)}</strong>
          </div>
        }
      >
        {(current) => (
          <>
            <div class="attachment-workbench-toolbar">
              <div class="attachment-workbench-heading">
                <FileIcon node={{ path: current().filename ?? "attachment", type: "file" }} class="size-5" />
                <div>
                  <strong title={current().filename}>{current().filename ?? lingui._(P.attachment)}</strong>
                  <span>
                    {[current().mime, formatAttachmentSize(attachmentBytes(current()))].filter(Boolean).join(" · ")}
                  </span>
                </div>
              </div>
              <div class="attachment-workbench-actions">
                <Show when={capability()?.dual}>
                  <div class="attachment-workbench-mode" role="group" aria-label={lingui._(A.viewMode)}>
                    <button type="button" aria-pressed={displayMode() === "source"} onClick={() => setMode("source")}>
                      {lingui._(A.source)}
                    </button>
                    <button type="button" aria-pressed={displayMode() === "preview"} onClick={() => setMode("preview")}>
                      {lingui._(A.preview)}
                    </button>
                  </div>
                </Show>
                <Show when={sourcePath()}>
                  {(path) => (
                    <button
                      type="button"
                      class="attachment-workbench-action"
                      onClick={() => void file.openWorkspaceFile(path())}
                    >
                      <Icon name={getSemanticIcon("workspace.files")} size="small" />
                      <span>{lingui._(A.viewSourceFile)}</span>
                    </button>
                  )}
                </Show>
                <Show when={url()}>
                  {(href) => (
                    <a
                      class="attachment-workbench-action"
                      href={href()}
                      download={current().filename}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Icon name={getSemanticIcon("action.download")} size="small" />
                      <span>{lingui._(A.download)}</span>
                    </a>
                  )}
                </Show>
              </div>
            </div>
            <main class="attachment-workbench-viewer">
              <Switch>
                <Match when={previewError() === "too-large"}>
                  <AttachmentState kind="warning" title={lingui._(A.tooLarge)} />
                </Match>
                <Match when={previewError() === "failed"}>
                  <AttachmentState
                    kind="warning"
                    title={lingui._(A.unableToPreview)}
                    detail={payload.error instanceof Error ? payload.error.message : String(payload.error)}
                  />
                </Match>
                <Match when={mediaFailed()}>
                  <AttachmentState kind="warning" title={lingui._(A.unableToPreview)} />
                </Match>
                <Match when={payload.loading}>
                  <div class="attachment-workbench-loading">
                    <Spinner class="size-5" />
                    <span>{lingui._(A.loading)}</span>
                  </div>
                </Match>
                <Match when={capability()?.kind === "pdf" ? payload() : undefined}>
                  {(bytes) => <AttachmentPdfPreview bytes={bytes()} />}
                </Match>
                <Match when={displayMode() === "source" ? text() : undefined}>
                  {(content) => (
                    <FileSourceView
                      path={`attachments/${current().id}/${current().filename ?? "attachment.txt"}`}
                      content={content()}
                    />
                  )}
                </Match>
                <Match when={capability()?.kind === "markdown" ? text() : undefined}>
                  {(content) => (
                    <div class="attachment-markdown-preview">
                      <Markdown text={content()} cacheKey={`attachment:${current().id}`} />
                    </div>
                  )}
                </Match>
                <Match when={capability()?.kind === "html" ? text() : undefined}>
                  {(content) => (
                    <div class="attachment-html-preview">
                      <RenderHtml html={sanitizeAttachmentHtml(content())} />
                    </div>
                  )}
                </Match>
                <Match when={capability()?.kind === "source" ? text() : undefined}>
                  {(content) => (
                    <FileSourceView
                      path={`attachments/${current().id}/${current().filename ?? "attachment.txt"}`}
                      content={content()}
                    />
                  )}
                </Match>
                <Match when={capability()?.kind === "video" && url()}>
                  <video
                    class="attachment-media-preview"
                    src={url()}
                    controls
                    preload="metadata"
                    onError={() => setMediaFailed(true)}
                  />
                </Match>
                <Match when={capability()?.kind === "audio" && url()}>
                  <audio
                    class="attachment-audio-preview"
                    src={url()}
                    controls
                    preload="metadata"
                    onError={() => setMediaFailed(true)}
                  />
                </Match>
                <Match when={true}>
                  <AttachmentState
                    kind="file"
                    title={current().filename ?? lingui._(P.attachment)}
                    detail={lingui._(A.unsupported)}
                  />
                </Match>
              </Switch>
            </main>
          </>
        )}
      </Show>
    </div>
  )
}

function AttachmentState(props: { kind: "warning" | "file"; title: string; detail?: string }) {
  return (
    <div class="attachment-workbench-state">
      <Show
        when={props.kind === "warning"}
        fallback={<FileIcon node={{ path: props.title, type: "file" }} class="size-8" />}
      >
        <Icon name={getSemanticIcon("state.warning")} size="normal" />
      </Show>
      <strong>{props.title}</strong>
      <Show when={props.detail}>{(detail) => <span>{detail()}</span>}</Show>
    </div>
  )
}
