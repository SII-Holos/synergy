import { createEffect, createMemo, createSignal, For, Match, onMount, Show, Switch, type JSX } from "solid-js"
import { useLingui } from "@lingui/solid"
import { useDialog } from "../context/dialog"
import { useResourceOpen } from "../context/resource-open"
import { FileIcon } from "./file-icon"
import { Icon } from "./icon"
import { ImagePreview } from "./image-preview"
import { getSemanticIcon } from "./semantic-icon"
import {
  attachmentColumns,
  attachmentMeta,
  isHtmlAttachment,
  isPdfAttachment,
  resolveAttachmentPresentation,
  resolveAttachmentOpenTarget,
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
  attachmentSourcePath,
  formatAttachmentSize,
  isImageAttachment,
  joinServerUrl,
  resolveAttachmentPresentation,
  resolveAttachmentOpenTarget,
  resolveAttachmentUrl,
  resolveImagePreviewImage,
} from "./attachment-card-utils"
import {
  claimSpeakAutoplay,
  finishSpeakAutoplay,
  rememberSpeakPlaybackPosition,
  speakPlaybackPosition,
} from "./session-turn-speak-autoplay"

const previewImageDescriptor = { id: "ui.attachment.previewImage", message: "Preview {filename}" }
const openAttachmentDescriptor = { id: "ui.attachment.openAttachment", message: "Open {filename}" }

export function AttachmentCard(props: {
  file: AttachmentFile
  serverUrl: string
  imagePreview?: { images: ImagePreviewImage[]; index: number }
  autoplay?: boolean
  autoplayKey?: string
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
  const [mounted, setMounted] = createSignal(false)
  let audioRef: HTMLAudioElement | undefined

  onMount(() => setMounted(true))

  // Speech the agent decided to announce (speak tool) plays on its own when
  // its freshly generated card renders, and keeps playing across the turn
  // settlement re-projection that remounts the card while audio is in
  // flight. Qualification is sticky in the tracker until the clip ends or
  // the user pauses, so a remounted card resumes from the remembered
  // position instead of silencing or restarting. Browsers may reject play()
  // without a user gesture — controls remain for manual playback.
  let autoplayWired = false
  const wireAutoplayEvents = (key: string) => {
    if (autoplayWired) return
    autoplayWired = true
    const element = audioRef
    if (!element) return
    const remember = () => rememberSpeakPlaybackPosition(key, element.currentTime)
    const finish = () => finishSpeakAutoplay(key)
    element.addEventListener("timeupdate", remember)
    element.addEventListener("ended", finish)
    element.addEventListener("pause", finish)
  }

  createEffect(() => {
    if (!props.autoplay || !mounted()) return
    const renderer = presentation().renderer
    const audioUrl = url()
    if (renderer !== "audio" || !audioUrl) return
    const element = audioRef
    if (!element) return
    if (props.autoplayKey !== undefined && !claimSpeakAutoplay(props.autoplayKey)) return
    if (props.autoplayKey !== undefined) {
      wireAutoplayEvents(props.autoplayKey)
      const resumeAt = speakPlaybackPosition(props.autoplayKey)
      if (resumeAt > 0 && (!element.duration || resumeAt < element.duration - 0.5)) {
        element.currentTime = resumeAt
      }
    }
    void element.play().catch(() => {})
  })

  const openAttachment = () => {
    const preview = props.imagePreview
    if (preview) {
      const images = preview.images.map((image) => ({
        ...image,
        sourcePath: resourceOpen?.resolveWorkspacePath?.(image.sourcePath),
      }))
      dialog.show(() => <ImagePreview images={images} initialIndex={preview.index} />)
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
          <button
            type="button"
            data-slot="attachment-card-open"
            aria-label={_({ ...openAttachmentDescriptor, values: { filename: filename() } })}
            title={_({ ...openAttachmentDescriptor, values: { filename: filename() } })}
            onClick={openAttachment}
          >
            <Icon name={getSemanticIcon("action.view")} size="small" />
          </button>
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
            <audio ref={audioRef} src={url()} controls preload="metadata" />
          </span>
          <button
            type="button"
            data-slot="attachment-card-open"
            aria-label={_({ ...openAttachmentDescriptor, values: { filename: filename() } })}
            title={_({ ...openAttachmentDescriptor, values: { filename: filename() } })}
            onClick={openAttachment}
          >
            <Icon name={getSemanticIcon("action.view")} size="small" />
          </button>
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
        <Icon name={props.onOpen ? getSemanticIcon("action.view") : getSemanticIcon("action.download")} size="small" />
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

export function AttachmentGallery(props: {
  files: AttachmentFile[]
  serverUrl: string
  align?: "start" | "end"
  autoplay?: boolean
  autoplayKey?: string
}) {
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
                      autoplay={props.autoplay}
                      autoplayKey={props.autoplay ? props.autoplayKey : undefined}
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
