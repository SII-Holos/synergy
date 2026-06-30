import { createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { useDialog } from "../context/dialog"
import { useResourceOpen } from "../context/resource-open"
import { FileIcon } from "./file-icon"
import { Icon } from "./icon"
import { ImagePreview } from "./image-preview"
import {
  attachmentColumns,
  attachmentMeta,
  isHtmlAttachment,
  isImageAttachment,
  isPdfAttachment,
  resolveAttachmentUrl,
  type AttachmentFile,
} from "./attachment-card-utils"
export type { AttachmentFile } from "./attachment-card-utils"
export {
  attachmentColumnCount,
  attachmentColumns,
  attachmentKind,
  formatAttachmentSize,
  isImageAttachment,
  joinServerUrl,
  resolveAttachmentUrl,
} from "./attachment-card-utils"

export function AttachmentCard(props: { file: AttachmentFile; serverUrl: string }) {
  const dialog = useDialog()
  const resourceOpen = useResourceOpen()
  const [imageFailed, setImageFailed] = createSignal(false)
  const url = createMemo(() => resolveAttachmentUrl(props.serverUrl, props.file))
  const filename = createMemo(() => props.file.filename ?? (isPdfAttachment(props.file) ? "file.pdf" : "file"))
  const meta = createMemo(() => attachmentMeta(props.file))
  const openAttachment = () => {
    if (resourceOpen?.openAttachment(props.file, { serverUrl: props.serverUrl })) return
    const href = url()
    if (!href) return
    if (isImageAttachment(props.file)) {
      dialog.show(() => <ImagePreview src={href} alt={filename()} />)
      return
    }
    window.open(href, "_blank", "noopener,noreferrer")
  }

  return (
    <Show
      when={isImageAttachment(props.file) && url() && !imageFailed()}
      fallback={
        <DynamicAttachmentLink
          url={url()}
          filename={filename()}
          type={isPdfAttachment(props.file) ? "pdf" : "file"}
          downloadable={!isPdfAttachment(props.file) && !isHtmlAttachment(props.file)}
          onOpen={resourceOpen ? openAttachment : undefined}
        >
          <span data-slot="attachment-card-preview">
            <FileIcon node={{ path: filename(), type: "file" }} />
          </span>
          <span data-slot="attachment-card-body">
            <span data-slot="attachment-card-filename">{filename()}</span>
            <span data-slot="attachment-card-meta">{meta()}</span>
          </span>
          <Show when={url()}>
            <Icon
              name={isPdfAttachment(props.file) || isHtmlAttachment(props.file) ? "scan-eye" : "download"}
              size="small"
            />
          </Show>
        </DynamicAttachmentLink>
      }
    >
      <button
        type="button"
        data-component="attachment-card"
        data-type="image"
        aria-label={`Preview ${filename()}`}
        title={filename()}
        onClick={openAttachment}
      >
        <img src={url()!} alt={filename()} loading="lazy" onError={() => setImageFailed(true)} />
      </button>
    </Show>
  )
}

function DynamicAttachmentLink(props: {
  url: string | undefined
  filename: string
  type: "pdf" | "file"
  downloadable: boolean
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
            <div data-component="attachment-card" data-type={props.type} data-disabled="true">
              {props.children}
            </div>
          }
        >
          {(url) => (
            <a
              data-component="attachment-card"
              data-type={props.type}
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
        <button data-component="attachment-card" data-type={props.type} type="button" onClick={onOpen()}>
          {props.children}
        </button>
      )}
    </Show>
  )
}

export function AttachmentGallery(props: {
  files: AttachmentFile[]
  serverUrl: string
  variant?: "default" | "result"
}) {
  const columns = createMemo(() => attachmentColumns(props.files))

  return (
    <Show when={columns().length > 0}>
      <div
        data-component="attachment-gallery"
        data-columns={columns().length}
        data-variant={props.variant ?? "default"}
      >
        <div data-slot="attachment-column-layout">
          <For each={columns()}>
            {(column) => (
              <div data-slot="attachment-column">
                <For each={column}>{(file) => <AttachmentCard file={file} serverUrl={props.serverUrl} />}</For>
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  )
}
