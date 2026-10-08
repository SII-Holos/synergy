import {
  lazy,
  Suspense,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js"
import { useLingui } from "@lingui/solid"
import {
  attachmentDocumentContext,
  formatAttachmentSize,
  resolveAttachmentUrl,
  type AttachmentFile,
} from "@ericsanchezok/synergy-ui/attachment-card"
import { FileIcon } from "@ericsanchezok/synergy-ui/file-icon"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { UserMarkdown } from "@ericsanchezok/synergy-ui/user-markdown"
import { Markdown } from "@ericsanchezok/synergy-ui/markdown"
import type { ResourceReference } from "@ericsanchezok/synergy-util/resource-reference"
import { RenderHtml } from "@ericsanchezok/synergy-ui/render-html"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { attachmentWorkbench as A, panels as P } from "@/locales/messages"
import {
  AttachmentTooLargeError,
  attachmentSourceMarkdown,
  attachmentOpenInBrowserUrl,
  createAttachmentPreviewReader,
} from "./model"
import { classifyResourcePreview } from "../resource-preview"
import { AttachmentPdfPreview } from "./pdf-preview"
import { sanitizeAttachmentHtml } from "./html"
import "./styles.css"

const OfficePreview = lazy(() => import("./office-preview").then((module) => ({ default: module.OfficePreview })))

function attachmentBytes(attachment: AttachmentFile) {
  const metadata = attachment.metadata?.attachment as Record<string, unknown> | undefined
  return attachment.size ?? (typeof metadata?.size === "number" ? metadata.size : undefined)
}

export interface AttachmentPreviewProps {
  file: AttachmentFile
  serverUrl: string
  fetcher?: typeof fetch
  sourceUrl?: string
  referenceContext?: ResourceReference.Context
  location?: ResourceReference.Location
  navigation?: number
  onOpenSource?: () => void
  onOpenBrowser?: (url: string) => void
  onOpenExternal?: (url: string) => void
}

export function AttachmentPreview(props: AttachmentPreviewProps) {
  const lingui = useLingui()
  const capability = createMemo(() => {
    const value = props.file
    return value ? classifyResourcePreview(value.mime, value.filename) : undefined
  })
  const [mode, setMode] = createSignal<"preview" | "source">("preview")
  const [mediaFailed, setMediaFailed] = createSignal(false)
  const url = createMemo(() => {
    const value = props.file
    return props.sourceUrl ?? (value ? resolveAttachmentUrl(props.serverUrl, value) : undefined)
  })
  const sourcePath = () => props.onOpenSource
  const previewRequest = createMemo(() => {
    const value = props.file
    const preview = capability()
    const href = url()
    if (!value || !preview?.maxBytes || !href) return undefined
    const size = attachmentBytes(value)
    if (size !== undefined && size > preview.maxBytes) {
      return { href, maxBytes: preview.maxBytes, tooLarge: true as const }
    }
    return { href, maxBytes: preview.maxBytes, tooLarge: false as const }
  })
  const previewReader = createAttachmentPreviewReader(props.fetcher ?? fetch)
  const [payload, { refetch }] = createResource(
    () => {
      const request = previewRequest()
      return request && !request.tooLarge ? request : undefined
    },
    async (request) => previewReader.read(request.href, request.maxBytes),
  )
  createEffect(() => {
    const request = previewRequest()
    if (!request || request.tooLarge) previewReader.cancel()
  })
  onCleanup(() => previewReader.cancel())
  const safePayload = () => (payload.error ? undefined : payload())
  const text = createMemo(() => {
    const bytes = safePayload()
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
      <div class="attachment-workbench-toolbar">
        <div class="attachment-workbench-heading">
          <FileIcon node={{ path: props.file.filename ?? "attachment", type: "file" }} class="size-5" />
          <div>
            <strong title={props.file.filename}>{props.file.filename ?? lingui._(P.attachment)}</strong>
            <span>
              {[props.file.mime, formatAttachmentSize(attachmentBytes(props.file))].filter(Boolean).join(" · ")}
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
              <button type="button" class="attachment-workbench-action" onClick={() => props.onOpenSource?.()}>
                <Icon name={getSemanticIcon("workspace.files")} size="small" />
                <span>{lingui._(A.viewSourceFile)}</span>
              </button>
            )}
          </Show>
          <Show when={props.onOpenBrowser && attachmentOpenInBrowserUrl(capability()?.kind, url())}>
            {(href) => (
              <button type="button" class="attachment-workbench-action" onClick={() => props.onOpenBrowser?.(href())}>
                <Icon name={getSemanticIcon("action.open")} size="small" />
                <span>{lingui._(A.openInBrowser)}</span>
              </button>
            )}
          </Show>
          <Show when={props.onOpenExternal && url()}>
            {(href) => (
              <button type="button" class="attachment-workbench-action" onClick={() => props.onOpenExternal?.(href())}>
                <Icon name={getSemanticIcon("action.external")} size="small" />
                <span>{lingui._(A.openFullPage)}</span>
              </button>
            )}
          </Show>
          <Show when={url()}>
            {(href) => (
              <a
                class="attachment-workbench-action"
                href={href()}
                download={props.file.filename}
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
              onRetry={() => void refetch()}
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
          <Match when={capability()?.kind === "xlsx" ? safePayload() : undefined}>
            {(bytes) => (
              <Suspense fallback={<Spinner />}>
                <OfficePreview format="xlsx" bytes={bytes()} filename={props.file.filename} />
              </Suspense>
            )}
          </Match>
          <Match when={capability()?.kind === "pptx" ? safePayload() : undefined}>
            {(bytes) => (
              <Suspense fallback={<Spinner />}>
                <OfficePreview format="pptx" bytes={bytes()} filename={props.file.filename} />
              </Suspense>
            )}
          </Match>
          <Match when={capability()?.kind === "docx" ? safePayload() : undefined}>
            {(bytes) => (
              <Suspense fallback={<Spinner />}>
                <OfficePreview format="docx" bytes={bytes()} filename={props.file.filename} />
              </Suspense>
            )}
          </Match>
          <Match when={capability()?.kind === "image" && url()}>
            {(href) => <AttachmentImagePreview url={href()} filename={props.file.filename} />}
          </Match>
          <Match when={capability()?.kind === "pdf" ? safePayload() : undefined}>
            {(bytes) => (
              <AttachmentPdfPreview bytes={bytes()} location={props.location} navigation={props.navigation} />
            )}
          </Match>
          <Match when={displayMode() === "source" ? text() : undefined}>
            {(content) => (
              <div class="attachment-source-preview">
                <UserMarkdown text={attachmentSourceMarkdown(content(), props.file.filename)} />
              </div>
            )}
          </Match>
          <Match when={capability()?.kind === "markdown" ? text() : undefined}>
            {(content) => (
              <div class="attachment-markdown-preview">
                <Markdown
                  text={content()}
                  referenceContext={attachmentDocumentContext(props.file, props.referenceContext)}
                  navigation={props.location ? { id: props.navigation ?? 0, location: props.location } : undefined}
                />
              </div>
            )}
          </Match>
          <Match when={capability()?.kind === "html" ? text() : undefined}>
            {(content) => (
              <div class="attachment-html-preview">
                <div class="attachment-html-preview-notice">{lingui._(A.htmlScriptsDisabled)}</div>
                <RenderHtml html={sanitizeAttachmentHtml(content())} />
              </div>
            )}
          </Match>
          <Match when={capability()?.kind === "svg" && url()}>
            {(href) => <AttachmentImagePreview url={href()} filename={props.file.filename} />}
          </Match>
          <Match when={capability()?.kind === "source" ? text() : undefined}>
            {(content) => (
              <div class="attachment-source-preview">
                <UserMarkdown text={attachmentSourceMarkdown(content(), props.file.filename)} />
              </div>
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
              title={props.file.filename ?? lingui._(P.attachment)}
              detail={lingui._(A.unsupported)}
            />
          </Match>
        </Switch>
      </main>
    </div>
  )
}

function AttachmentState(props: { kind: "warning" | "file"; title: string; detail?: string; onRetry?: () => void }) {
  const { _ } = useLingui()
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
      <Show when={props.onRetry}>
        <button type="button" class="attachment-workbench-action" onClick={() => props.onRetry?.()}>
          {_({ id: "app.workspace.panel.retry", message: "Retry" })}
        </button>
      </Show>
    </div>
  )
}

function AttachmentImagePreview(props: { url: string; filename?: string }) {
  const lingui = useLingui()
  const [scale, setScale] = createSignal(1)
  const [failed, setFailed] = createSignal(false)
  createEffect(() => {
    props.url
    setScale(1)
    setFailed(false)
  })
  return (
    <div class="attachment-image-preview">
      <div class="attachment-pdf-toolbar">
        <button
          type="button"
          aria-label={lingui._(A.zoomOut)}
          disabled={scale() <= 0.25}
          onClick={() => setScale((v) => Math.max(0.25, v - 0.25))}
        >
          <Icon name={getSemanticIcon("action.zoomOut")} size="small" />
        </button>
        <span>{Math.round(scale() * 100)}%</span>
        <button type="button" onClick={() => setScale(1)}>
          {lingui._(A.fitWidth)}
        </button>
        <button
          type="button"
          aria-label={lingui._(A.zoomIn)}
          disabled={scale() >= 4}
          onClick={() => setScale((v) => Math.min(4, v + 0.25))}
        >
          <Icon name={getSemanticIcon("action.zoomIn")} size="small" />
        </button>
      </div>
      <Show
        when={!failed()}
        fallback={
          <AttachmentState kind="warning" title={lingui._(A.unableToPreview)} onRetry={() => setFailed(false)} />
        }
      >
        <div class="attachment-image-stage">
          <img
            src={props.url}
            alt={props.filename ?? ""}
            style={{ width: `${scale() * 100}%` }}
            onError={() => setFailed(true)}
          />
        </div>
      </Show>
    </div>
  )
}
