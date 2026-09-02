import DOMPurify from "dompurify"
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useLingui } from "@lingui/solid"
import { FileIcon } from "@ericsanchezok/synergy-ui/file-icon"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { Markdown } from "@ericsanchezok/synergy-ui/markdown"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useFile } from "@/context/file"
import { usePlatform } from "@/context/platform"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { fileWriteErrorMessage, isFileWriteConflictError, isFileWriteDeniedError } from "@/context/file/errors"
import type { WorkbenchPanelContentProps } from "@/plugin/registries/workbench-panel-registry"
import { FileExplorer } from "./explorer"
import { classifyFilePreview, resolveWorkspaceRelativePath } from "./model"
import { buildWorkspaceFileBrowserUrl, buildWorkspaceFilePreviewUrl } from "@/utils/workspace-file-url"
import { AttachmentPdfPreview } from "@/components/attachment-workbench/pdf-preview"
import { FileSourceView, type FileSourceViewApi } from "./source-view"
import "./styles.css"
import { fileWorkbench as F } from "@/locales/messages"
import { useLocale } from "@/context/locale"
import "@/components/attachment-workbench/styles.css"
import type { PdfDocumentState } from "@/context/file"

function selectionLabel(range: { start: number; end: number }) {
  const start = Math.min(range.start, range.end)
  const end = Math.max(range.start, range.end)
  return start === end ? `L${start}` : `L${start}–L${end}`
}

function MarkdownPreview(props: { path: string; content: string }) {
  const file = useFile()
  let root!: HTMLDivElement
  let observer: MutationObserver | undefined
  const processed = new WeakSet<Element>()
  let imageCount = 0
  let imageBytes = 0
  let disposed = false

  const processImages = () => {
    for (const image of root.querySelectorAll<HTMLImageElement>("img[src]")) {
      if (processed.has(image)) continue
      processed.add(image)
      const src = image.getAttribute("src") ?? ""
      if (/^(?:data:|blob:|https?:)/i.test(src)) continue
      const path = resolveWorkspaceRelativePath(props.path, src)
      if (!path || imageCount >= 20) {
        image.removeAttribute("src")
        continue
      }
      imageCount += 1
      void file.load(path).then(() => {
        if (disposed) return
        const content = file.get(path)?.content
        if (content?.kind !== "image") {
          image.removeAttribute("src")
          return
        }
        if (imageBytes + content.totalBytes > 32 * 1024 * 1024) {
          image.removeAttribute("src")
          return
        }
        imageBytes += content.totalBytes
        image.src = `data:${content.mimeType};base64,${content.content}`
      })
    }
  }

  onMount(() => {
    observer = new MutationObserver(processImages)
    observer.observe(root, { childList: true, subtree: true })
    processImages()
  })
  onCleanup(() => {
    disposed = true
    observer?.disconnect()
  })

  return (
    <div
      ref={root}
      class="file-markdown-preview"
      onClick={(event) => {
        const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[href]")
        if (!anchor) return
        const href = anchor.getAttribute("href") ?? ""
        if (href.startsWith("#")) return
        if (/^https?:/i.test(href)) {
          anchor.target = "_blank"
          anchor.rel = "noopener noreferrer"
          return
        }
        event.preventDefault()
        const path = resolveWorkspaceRelativePath(props.path, href)
        if (path) void file.openWorkspaceFile(path)
      }}
    >
      <Markdown text={props.content} cacheKey={`file-preview:${props.path}`} />
    </div>
  )
}

function SvgPreview(props: { path: string; content: string }) {
  const [url, setUrl] = createSignal<string>()
  createEffect(() => {
    const sanitized = DOMPurify.sanitize(props.content, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ["script", "foreignObject"],
      FORBID_ATTR: ["onload", "onclick", "onerror"],
    })
    const parsed = new DOMParser().parseFromString(String(sanitized), "image/svg+xml")
    for (const element of parsed.querySelectorAll("*")) {
      for (const attribute of Array.from(element.attributes)) {
        if (attribute.name !== "href" && attribute.name !== "xlink:href") continue
        if (attribute.value.startsWith("#") || attribute.value.startsWith("data:image/")) continue
        element.removeAttribute(attribute.name)
      }
    }
    const safeSvg = new XMLSerializer().serializeToString(parsed.documentElement)
    const next = URL.createObjectURL(new Blob([safeSvg], { type: "image/svg+xml" }))
    setUrl(next)
    onCleanup(() => URL.revokeObjectURL(next))
  })
  return <Show when={url()}>{(src) => <img class="file-svg-preview" src={src()} alt={props.path} />}</Show>
}

// Served through the workspace raw-file route: relative resources resolve, and
// the server puts the document in a CSP-sandboxed opaque origin, so scripts run
// but cannot reach the app origin, its storage, or the HTTP control plane.
// The frame must be same-origin with the app because the route sets
// X-Frame-Options: SAMEORIGIN: when the SDK base points at another origin (bun
// dev serves the app from Vite and the server from :4096), fall back to the app
// origin, which Vite proxies to the server. The version query forces a reload
// when the file changes on disk (watcher events, edits, focus refresh).
function HtmlPreview(props: { path: string; version?: { mtime: number; size: number } }) {
  const sdk = useSDK()
  const lingui = useLingui()
  const [loaded, setLoaded] = createSignal(false)
  const url = createMemo(() =>
    buildWorkspaceFilePreviewUrl(
      sdk.url,
      window.location.origin,
      props.path,
      {
        scopeID: sdk.scopeID,
        directory: sdk.directory,
      },
      props.version,
    ),
  )
  // A new URL (path switch or disk version change) reloads the frame; show the
  // loading state until its load event fires. Time out so a blocked frame (for
  // example an X-Frame-Options refusal) never leaves a permanent spinner.
  let hideTimer: number | undefined
  createEffect(() => {
    url()
    setLoaded(false)
    window.clearTimeout(hideTimer)
    hideTimer = window.setTimeout(() => setLoaded(true), 15000)
    onCleanup(() => window.clearTimeout(hideTimer))
  })
  return (
    <div class="file-html-preview-shell">
      <Show when={!loaded()}>
        <div class="file-workbench-loading">
          <Spinner class="size-5" />
          <span>
            {lingui._({
              id: F.loading.id,
              message: F.loading.message,
              values: { path: props.path },
            })}
          </span>
        </div>
      </Show>
      <iframe
        class="file-html-preview"
        sandbox="allow-scripts"
        src={url()}
        title={props.path}
        onLoad={() => setLoaded(true)}
      />
    </div>
  )
}

function ImagePreview(props: {
  path: string
  mimeType: string
  content: string
  lingui: ReturnType<typeof useLingui>
}) {
  const file = useFile()
  const [scale, setScale] = createSignal(file.view.imageScaleMode(props.path) === "actual" ? 1 : 0)
  const [pan, setPan] = createSignal({ x: 0, y: 0 })
  const [drag, setDrag] = createSignal<{ id: number; x: number; y: number; startX: number; startY: number }>()
  const actualScale = () => (scale() === 0 ? 1 : scale())
  const fit = () => scale() === 0
  const resetPan = () => setPan({ x: 0, y: 0 })

  return (
    <div class="file-image-preview">
      <div class="file-image-controls">
        <button
          type="button"
          classList={{ active: fit() }}
          onClick={() => {
            setScale(0)
            resetPan()
            file.view.setImageScaleMode(props.path, "fit")
          }}
        >
          {props.lingui._({ id: F.fit.id, message: F.fit.message })}
        </button>
        <button
          type="button"
          classList={{ active: scale() === 1 }}
          onClick={() => {
            setScale(1)
            resetPan()
            file.view.setImageScaleMode(props.path, "actual")
          }}
        >
          100%
        </button>
        <button
          type="button"
          aria-label={props.lingui._({ id: F.zoomOut.id, message: F.zoomOut.message })}
          onClick={() => setScale((value) => Math.max(0.25, (value || 1) - 0.25))}
        >
          −
        </button>
        <button
          type="button"
          aria-label={props.lingui._({ id: F.zoomIn.id, message: F.zoomIn.message })}
          onClick={() => setScale((value) => Math.min(8, (value || 1) + 0.25))}
        >
          +
        </button>
      </div>
      <div
        class="file-image-stage"
        onWheel={(event) => {
          if (!event.ctrlKey && !event.metaKey) return
          event.preventDefault()
          setScale((value) => Math.max(0.25, Math.min(8, (value || 1) + (event.deltaY < 0 ? 0.25 : -0.25))))
        }}
        onPointerDown={(event) => {
          if (fit() || event.button !== 0) return
          event.currentTarget.setPointerCapture(event.pointerId)
          const current = pan()
          setDrag({ id: event.pointerId, x: event.clientX, y: event.clientY, startX: current.x, startY: current.y })
        }}
        onPointerMove={(event) => {
          const current = drag()
          if (!current || current.id !== event.pointerId) return
          setPan({ x: current.startX + event.clientX - current.x, y: current.startY + event.clientY - current.y })
        }}
        onPointerUp={() => setDrag(undefined)}
        onPointerCancel={() => setDrag(undefined)}
      >
        <img
          src={`data:${props.mimeType};base64,${props.content}`}
          alt={props.path}
          classList={{ "file-image--fit": fit(), "file-image--actual": !fit() }}
          style={{ transform: fit() ? undefined : `translate(${pan().x}px, ${pan().y}px) scale(${actualScale()})` }}
          draggable={false}
        />
      </div>
    </div>
  )
}

function FilePdfPreview(props: {
  state: PdfDocumentState | undefined
  path: string
  totalBytes: number | undefined
  lingui: ReturnType<typeof useLingui>
  onRetry: () => void
}) {
  return (
    <Show
      when={props.state?.bytes}
      fallback={
        <Show
          when={props.state?.tooLarge}
          fallback={
            <Show
              when={props.state?.error}
              fallback={
                <div class="file-workbench-loading">
                  <Spinner class="size-5" />
                  <span>
                    {props.lingui._({
                      id: F.loading.id,
                      message: F.loading.message,
                      values: { path: props.path },
                    })}
                  </span>
                </div>
              }
            >
              {(message) => (
                <div class="file-workbench-state">
                  <FileIcon node={{ path: props.path, type: "file" }} class="size-10" />
                  <strong>{props.lingui._({ id: F.pdfPreviewFailed.id, message: F.pdfPreviewFailed.message })}</strong>
                  <Show when={message() !== "not-found"}>
                    <span>{message()}</span>
                  </Show>
                  <button type="button" onClick={props.onRetry}>
                    {props.lingui._({ id: F.retry.id, message: F.retry.message })}
                  </button>
                </div>
              )}
            </Show>
          }
        >
          <div class="file-workbench-state">
            <FileIcon node={{ path: props.path, type: "file" }} class="size-10" />
            <strong>{props.lingui._({ id: F.pdfTooLarge.id, message: F.pdfTooLarge.message })}</strong>
            <span>
              {props.lingui._({
                id: F.binaryInfo.id,
                message: F.binaryInfo.message,
                values: {
                  mimeType: "application/pdf",
                  bytes: props.totalBytes ?? props.state?.version?.size ?? 0,
                },
              })}
            </span>
          </div>
        </Show>
      }
    >
      {(bytes) => <AttachmentPdfPreview bytes={bytes()} />}
    </Show>
  )
}

export function FileWorkbenchContent(props: WorkbenchPanelContentProps) {
  const file = useFile()
  const platform = usePlatform()
  const sdk = useSDK()
  const prompt = usePrompt()
  const { fmt } = useLocale()
  const lingui = useLingui()
  const path = createMemo(() => props.tab.resourceId ?? "")
  const isHtml = createMemo(() => /\.html?$/i.test(path()))
  const documentState = createMemo(() => file.get(path()))
  const content = createMemo(() => documentState()?.content)
  const textContent = createMemo(() => {
    const value = content()
    return value?.kind === "text" ? value : undefined
  })
  const imageContent = createMemo(() => {
    const value = content()
    return value?.kind === "image" ? value : undefined
  })
  const binaryContent = createMemo(() => {
    const value = content()
    return value?.kind === "binary" ? value : undefined
  })
  const pdfContent = createMemo(() => file.pdf.get(path()))
  const capability = createMemo(() => {
    const value = content()
    return classifyFilePreview(path(), value?.kind ?? "binary", value?.mimeType)
  })
  const mode = createMemo(() => {
    const saved = file.view.mode(path())
    if (capability().dual && saved) return saved
    return capability().defaultMode
  })
  const selectedLines = createMemo(() => file.view.selectedLines(path()))
  const breadcrumb = createMemo(() => path().split("/").filter(Boolean))
  const [editing, setEditing] = createSignal(false)
  const [dirty, setDirty] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  let sourceApi: FileSourceViewApi | undefined
  const canEdit = createMemo(() => mode() === "source" && !!textContent() && textContent()?.truncationReason !== "size")

  async function runSave(overwrite = false) {
    if (!sourceApi || saving()) return
    setSaving(true)
    try {
      await file.save(path(), sourceApi.getContent(), { overwrite })
      setDirty(false)
      setEditing(false)
      showToast({
        type: "success",
        title: lingui._({ id: F.saved.id, message: F.saved.message }),
      })
    } catch (error) {
      if (isFileWriteConflictError(error)) {
        showToast({
          type: "warning",
          title: lingui._({ id: F.saveConflict.id, message: F.saveConflict.message }),
          description: lingui._({ id: F.saveConflictOverwrite.id, message: F.saveConflictOverwrite.message }),
          actions: [
            {
              label: lingui._({ id: F.overwrite.id, message: F.overwrite.message }),
              onClick: () => void runSave(true),
            },
            { label: lingui._({ id: F.dismiss.id, message: F.dismiss.message }), onClick: "dismiss" },
          ],
        })
      } else if (isFileWriteDeniedError(error)) {
        showToast({
          type: "error",
          title: lingui._({ id: F.saveDenied.id, message: F.saveDenied.message }),
          description: fileWriteErrorMessage(error),
        })
      } else {
        showToast({
          type: "error",
          title: lingui._({ id: F.saveFailed.id, message: F.saveFailed.message }),
          description: fileWriteErrorMessage(error),
        })
      }
    } finally {
      setSaving(false)
    }
  }

  function startEdit() {
    if (editing()) return
    setDirty(false)
    setEditing(true)
  }

  function cancelEdit() {
    if (!editing()) return
    const value = textContent()
    if (value) sourceApi?.applyContent(value.content)
    setDirty(false)
    setEditing(false)
  }

  createEffect(() => {
    if (!path()) return
    void file.load(path())
    if (capability().kind === "pdf") void file.pdf.load(path())
  })

  onMount(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        if (!editing()) return
        event.preventDefault()
        void runSave()
        return
      }
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.key.toLowerCase() !== "v") return
      if (!capability().dual) return
      event.preventDefault()
      file.view.setMode(path(), mode() === "source" ? "preview" : "source")
    }
    document.addEventListener("keydown", onKeyDown)
    onCleanup(() => document.removeEventListener("keydown", onKeyDown))
  })

  return (
    <div class="file-workbench">
      <div class="file-workbench-toolbar">
        <nav class="file-breadcrumb" aria-label={lingui._({ id: F.filePath.id, message: F.filePath.message })}>
          <Show when={breadcrumb().length === 0}>
            <span class="file-breadcrumb-root">/</span>
          </Show>
          <For each={breadcrumb()}>
            {(part, index) => {
              const target = () =>
                breadcrumb()
                  .slice(0, index() + 1)
                  .join("/")
              const current = () => index() === breadcrumb().length - 1
              return (
                <>
                  <Show when={index() > 0}>
                    <span class="file-breadcrumb-separator">/</span>
                  </Show>
                  <button
                    type="button"
                    classList={{ "file-breadcrumb-current": current() }}
                    disabled={current()}
                    onClick={() => {
                      file.explorer.setOpen(true)
                      void file.explorer.reveal(`${target()}/__reveal__`)
                    }}
                  >
                    {part}
                  </button>
                </>
              )
            }}
          </For>
        </nav>
        <div class="file-toolbar-actions">
          <Show when={selectedLines()}>
            {(range) => (
              <button
                type="button"
                class="file-add-context"
                onClick={() =>
                  prompt.context.add({
                    type: "file",
                    path: path(),
                    selection: {
                      startLine: Math.min(range().start, range().end),
                      endLine: Math.max(range().start, range().end),
                      startChar: 0,
                      endChar: 0,
                    },
                  })
                }
              >
                <span>{selectionLabel(range())}</span>
                <span>{lingui._({ id: F.addToContext.id, message: F.addToContext.message })}</span>
              </button>
            )}
          </Show>
          <Show when={capability().dual}>
            <div
              class="file-view-toggle"
              role="group"
              aria-label={lingui._({ id: F.viewMode.id, message: F.viewMode.message })}
            >
              <button
                type="button"
                aria-pressed={mode() === "source"}
                onClick={() => file.view.setMode(path(), "source")}
              >
                {lingui._({ id: F.source.id, message: F.source.message })}
              </button>
              <button
                type="button"
                aria-pressed={mode() === "preview"}
                onClick={() => file.view.setMode(path(), "preview")}
              >
                {lingui._({ id: F.preview.id, message: F.preview.message })}
              </button>
            </div>
          </Show>
          <Show when={canEdit()}>
            <Show
              when={!editing()}
              fallback={
                <>
                  <button
                    type="button"
                    class="file-edit-pill file-edit-pill--save"
                    disabled={saving() || !dirty()}
                    onClick={() => void runSave()}
                  >
                    <Icon name={getSemanticIcon("state.success")} size="small" />
                    <span>
                      {saving()
                        ? lingui._({ id: F.saving.id, message: F.saving.message })
                        : lingui._({ id: F.save.id, message: F.save.message })}
                    </span>
                  </button>
                  <button
                    type="button"
                    class="file-edit-pill"
                    disabled={saving()}
                    onClick={cancelEdit}
                    aria-label={lingui._({ id: F.discard.id, message: F.discard.message })}
                  >
                    <Icon name={getSemanticIcon("action.clear")} size="small" />
                  </button>
                </>
              }
            >
              <button
                type="button"
                class="file-edit-pill"
                classList={{ "file-edit-pill--active": editing() }}
                onClick={startEdit}
              >
                <Icon name={getSemanticIcon("action.rename")} size="small" />
                <span>{lingui._({ id: F.edit.id, message: F.edit.message })}</span>
              </button>
            </Show>
          </Show>
          <Show when={isHtml()}>
            <button
              type="button"
              class="file-open-in-browser"
              onClick={() =>
                platform.openLink(
                  buildWorkspaceFileBrowserUrl(sdk.url, path(), { scopeID: sdk.scopeID, directory: sdk.directory }),
                )
              }
            >
              <Icon name={getSemanticIcon("action.open")} size="small" />
              <span>{lingui._({ id: F.openInBrowser.id, message: F.openInBrowser.message })}</span>
            </button>
          </Show>
          <IconButton
            icon={getSemanticIcon("workspace.files")}
            variant="ghost"
            class="file-tree-toggle"
            aria-label={lingui._({ id: F.toggleFileTree.id, message: F.toggleFileTree.message })}
            aria-pressed={file.explorer.open()}
            onClick={() => file.explorer.setOpen(!file.explorer.open())}
          />
        </div>
      </div>
      <div class="file-workbench-main">
        <main class="file-viewer">
          <Show when={documentState()?.deleted}>
            <div class="file-state-banner">
              <span>{lingui._({ id: F.fileDeleted.id, message: F.fileDeleted.message })}</span>
              <button type="button" onClick={() => file.load(path(), { force: true })}>
                {lingui._({ id: F.retry.id, message: F.retry.message })}
              </button>
              <button type="button" onClick={props.onRequestClose}>
                {lingui._({ id: F.close.id, message: F.close.message })}
              </button>
            </div>
          </Show>
          <Show when={textContent()?.truncationReason === "size"}>
            <div class="file-state-banner">
              {lingui._({ id: F.fileTruncated.id, message: F.fileTruncated.message })}
            </div>
          </Show>
          <Switch>
            <Match when={!path()}>
              <div class="file-workbench-state file-workbench-empty">
                <FileIcon node={{ path: "workspace", type: "directory" }} expanded class="size-10" />
                <strong>{lingui._({ id: F.openAFile.id, message: F.openAFile.message })}</strong>
                <span>{lingui._({ id: F.chooseFromTree.id, message: F.chooseFromTree.message })}</span>
              </div>
            </Match>
            <Match when={documentState()?.loading && !content()}>
              <div class="file-workbench-loading">
                <Spinner class="size-5" />
                <span>{lingui._({ id: F.loading.id, message: F.loading.message, values: { path: path() } })}</span>
              </div>
            </Match>
            <Match when={documentState()?.error && !content()}>
              {(error) => (
                <div class="file-workbench-state">
                  <FileIcon node={{ path: path(), type: "file" }} class="size-10" />
                  <strong>{lingui._({ id: F.unableToOpen.id, message: F.unableToOpen.message })}</strong>
                  <span>{error()}</span>
                  <button type="button" onClick={() => file.load(path(), { force: true })}>
                    {lingui._({ id: F.retry.id, message: F.retry.message })}
                  </button>
                </div>
              )}
            </Match>
            <Match when={mode() === "source" ? textContent() : undefined}>
              {(value) => (
                <FileSourceView
                  path={path()}
                  content={value().content}
                  editable={editing()}
                  onDirtyChange={setDirty}
                  onRegister={(api) => {
                    sourceApi = api
                  }}
                />
              )}
            </Match>
            <Match when={capability().kind === "markdown" ? textContent() : undefined}>
              {(value) => <MarkdownPreview path={path()} content={value().content} />}
            </Match>
            <Match when={capability().kind === "svg" ? textContent() : undefined}>
              {(value) => <SvgPreview path={path()} content={value().content} />}
            </Match>
            <Match when={capability().kind === "html" ? textContent() : undefined}>
              <HtmlPreview path={path()} version={documentState()?.version} />
            </Match>
            <Match when={imageContent()}>
              {(value) => (
                <ImagePreview path={path()} mimeType={value().mimeType} content={value().content} lingui={lingui} />
              )}
            </Match>
            <Match when={capability().kind === "pdf"}>
              <FilePdfPreview
                state={pdfContent()}
                path={path()}
                totalBytes={documentState()?.node?.size ?? documentState()?.version?.size}
                lingui={lingui}
                onRetry={() => void file.pdf.load(path(), { force: true })}
              />
            </Match>
            <Match when={binaryContent()}>
              {(value) => (
                <div class="file-workbench-state">
                  <FileIcon node={{ path: path(), type: "file" }} class="size-12" />
                  <strong>{path().split("/").at(-1)}</strong>
                  <span>
                    {lingui._({
                      id: F.binaryInfo.id,
                      message: F.binaryInfo.message,
                      values: {
                        mimeType: value().mimeType ?? "Unknown file type",
                        bytes: fmt.number(value().totalBytes),
                      },
                    })}
                  </span>
                  <p>{value().unsupportedReason}</p>
                </div>
              )}
            </Match>
          </Switch>
        </main>
        <Show when={file.explorer.open()}>
          <FileExplorer onClose={() => file.explorer.setOpen(false)} />
        </Show>
      </div>
    </div>
  )
}
