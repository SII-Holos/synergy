import { createMemo, createSignal, For, Match, Show, Switch, type JSX } from "solid-js"
import { useLingui } from "@lingui/solid"
import { useDialog } from "../context/dialog"
import { useResourceOpen } from "../context/resource-open"
import { FileIcon } from "./file-icon"
import { Icon } from "./icon"
import { ImagePreview } from "./image-preview"
import {
  attachmentColumns,
  attachmentMeta,
  isHtmlAttachment,
  isPdfAttachment,
  resolveAttachmentPresentation,
  resolveAttachmentThumbnailUrl,
  resolveAttachmentUrl,
  resolveImagePreviewImage,
  type AttachmentFile,
} from "./attachment-card-utils"
import type { ImagePreviewImage } from "./image-preview-model"
export type { AttachmentFile } from "./attachment-card-utils"
export {
  attachmentColumnCount,
  attachmentColumns,
  attachmentKind,
  formatAttachmentSize,
  isImageAttachment,
  joinServerUrl,
  resolveAttachmentPresentation,
  resolveAttachmentUrl,
  resolveImagePreviewImage,
} from "./attachment-card-utils"

const previewImageDescriptor = { id: "ui.attachment.previewImage", message: "Preview {filename}" }
const openAttachmentDescriptor = { id: "ui.attachment.openAttachment", message: "Open {filename}" }

export function AttachmentCard(props: {
  file: AttachmentFile
  serverUrl: string
  imagePreview?: { images: ImagePreviewImage[]; index: number }
}) {
  const { _ } = useLingui()
  const dialog = useDialog()
  const resourceOpen = useResourceOpen()
  const [imageFailed, setImageFailed] = createSignal(false)
  const url = createMemo(() => resolveAttachmentUrl(props.serverUrl, props.file))
  const thumbnailUrl = createMemo(() => resolveAttachmentThumbnailUrl(props.serverUrl, props.file))
  const presentation = createMemo(() => resolveAttachmentPresentation(props.file))
  const filename = createMemo(() => props.file.filename ?? (isPdfAttachment(props.file) ? "file.pdf" : "file"))
  const meta = createMemo(() => attachmentMeta(props.file))
  const openAttachment = () => {
    const preview = props.imagePreview
    if (preview) {
      dialog.show(() => <ImagePreview images={preview.images} initialIndex={preview.index} />)
      return
    }
    if (resourceOpen?.openAttachment(props.file, { serverUrl: props.serverUrl })) return
    const href = url()
    if (!href) return
    window.open(href, "_blank", "noopener,noreferrer")
  }

  const size = () => presentation().size
  const crop = () => (presentation().crop ? "true" : "false")

  return (
    <Switch
      fallback={
        <FileAttachmentCard
          url={url()}
          filename={filename()}
          meta={meta()}
          file={props.file}
          size={size()}
          onOpen={resourceOpen ? openAttachment : undefined}
        />
      }
    >
      <Match when={presentation().renderer === "image" && url() && !imageFailed()}>
        <button
          type="button"
          data-component="attachment-card"
          data-type="image"
          data-size={size()}
          data-crop={crop()}
          aria-label={_({ ...previewImageDescriptor, values: { filename: filename() } })}
          title={filename()}
          onClick={openAttachment}
        >
          <img src={url()!} alt={filename()} loading="lazy" onError={() => setImageFailed(true)} />
        </button>
      </Match>
      <Match when={presentation().renderer === "video" && url()}>
        <div data-component="attachment-card" data-type="video" data-size={size()} data-crop={crop()}>
          <video src={url()} controls preload="metadata" title={filename()} />
        </div>
      </Match>
      <Match when={presentation().renderer === "audio" && url()}>
        <div data-component="attachment-card" data-type="audio" data-size={size()}>
          <span data-slot="attachment-card-preview">
            <FileIcon node={{ path: filename(), type: "file" }} />
          </span>
          <span data-slot="attachment-card-body">
            <span data-slot="attachment-card-filename">{filename()}</span>
            <span data-slot="attachment-card-meta">{meta()}</span>
            <audio src={url()} controls preload="metadata" />
          </span>
        </div>
      </Match>
      <Match when={presentation().renderer === "thumbnail" && thumbnailUrl() && !imageFailed()}>
        <button
          type="button"
          data-component="attachment-card"
          data-type="thumbnail"
          data-size={size()}
          data-crop={crop()}
          aria-label={_({ ...openAttachmentDescriptor, values: { filename: filename() } })}
          title={filename()}
          onClick={openAttachment}
        >
          <img src={thumbnailUrl()!} alt={filename()} loading="lazy" onError={() => setImageFailed(true)} />
          <span data-slot="attachment-card-thumbnail-meta">
            <span data-slot="attachment-card-filename">{filename()}</span>
            <span data-slot="attachment-card-meta">{meta()}</span>
          </span>
        </button>
      </Match>
    </Switch>
  )
}

function FileAttachmentCard(props: {
  url: string | undefined
  filename: string
  meta: string
  file: AttachmentFile
  size: string
  onOpen?: () => void
}) {
  return (
    <DynamicAttachmentLink
      url={props.url}
      filename={props.filename}
      type={isPdfAttachment(props.file) ? "pdf" : "file"}
      downloadable={!isPdfAttachment(props.file) && !isHtmlAttachment(props.file)}
      size={props.size}
      onOpen={props.onOpen}
    >
      <span data-slot="attachment-card-preview">
        <FileIcon node={{ path: props.filename, type: "file" }} />
      </span>
      <span data-slot="attachment-card-body">
        <span data-slot="attachment-card-filename">{props.filename}</span>
        <span data-slot="attachment-card-meta">{props.meta}</span>
      </span>
      <Show when={props.url}>
        <Icon
          name={isPdfAttachment(props.file) || isHtmlAttachment(props.file) ? "scan-eye" : "download"}
          size="small"
        />
      </Show>
    </DynamicAttachmentLink>
  )
}

function DynamicAttachmentLink(props: {
  url: string | undefined
  filename: string
  type: "pdf" | "file"
  downloadable: boolean
  size: string
  onOpen?: () => void
  children: JSX.Element
}) {
  return (
    <Show
      when={props.onOpen}
      fallback={
        <Show
          when={props.url}
          fallback={
            <div data-component="attachment-card" data-type={props.type} data-size={props.size} data-disabled="true">
              {props.children}
            </div>
          }
        >
          {(url) => (
            <a
              data-component="attachment-card"
              data-type={props.type}
              data-size={props.size}
              href={url()}
              download={props.downloadable ? props.filename : undefined}
              target="_blank"
              rel="noopener noreferrer"
            >
              {props.children}
            </a>
          )}
        </Show>
      }
    >
      {(onOpen) => (
        <button
          data-component="attachment-card"
          data-type={props.type}
          data-size={props.size}
          type="button"
          onClick={onOpen()}
        >
          {props.children}
        </button>
      )}
    </Show>
  )
}

interface AttachmentGalleryEntry {
  file: AttachmentFile
  imagePreview?: ImagePreviewImage
  imagePreviewIndex?: number
}

export function AttachmentGallery(props: { files: AttachmentFile[]; serverUrl: string; align?: "start" | "end" }) {
  const visibleFiles = createMemo(() => props.files.filter((file) => !resolveAttachmentPresentation(file).hidden))
  const entries = createMemo<AttachmentGalleryEntry[]>(() => {
    let previewIndex = 0
    return visibleFiles().map((file, index) => {
      const imagePreview = resolveImagePreviewImage(props.serverUrl, file, index)
      if (!imagePreview) return { file }
      return { file, imagePreview, imagePreviewIndex: previewIndex++ }
    })
  })
  const previewImages = createMemo(() =>
    entries()
      .map((entry) => entry.imagePreview)
      .filter((image): image is ImagePreviewImage => Boolean(image)),
  )
  const columns = createMemo(() => attachmentColumns(entries()))
  return (
    <Show when={columns().length > 0}>
      <div data-component="attachment-gallery" data-columns={columns().length} data-align={props.align ?? "start"}>
        <div data-slot="attachment-column-layout">
          <For each={columns()}>
            {(column) => (
              <div data-slot="attachment-column">
                <For each={column}>
                  {(entry) => (
                    <AttachmentCard
                      file={entry.file}
                      serverUrl={props.serverUrl}
                      imagePreview={
                        entry.imagePreviewIndex !== undefined
                          ? { images: previewImages(), index: entry.imagePreviewIndex }
                          : undefined
                      }
                    />
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  )
}
