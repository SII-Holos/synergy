import { createMemo, For, Show } from "solid-js"
import { useDialog } from "../context/dialog"
import { FileIcon } from "./file-icon"
import { Icon } from "./icon"
import { ImagePreview } from "./image-preview"

export interface AttachmentFile {
  mime: string
  filename?: string
  url?: string
  assetId?: string
  size?: number
}

function joinServerUrl(serverUrl: string, pathname: string): string {
  return `${serverUrl.replace(/\/$/, "")}${pathname.startsWith("/") ? pathname : `/${pathname}`}`
}

function resolveUrl(serverUrl: string, file: AttachmentFile): string | undefined {
  if (file.url) {
    if (file.url.startsWith("asset://")) {
      return joinServerUrl(serverUrl, `/asset/${file.url.slice(8)}`)
    }
    return file.url
  }
  if (file.assetId) {
    return joinServerUrl(serverUrl, `/asset/${file.assetId}`)
  }
  return undefined
}

function isImage(file: AttachmentFile): boolean {
  return file.mime.startsWith("image/")
}

function isPdf(file: AttachmentFile): boolean {
  return file.mime === "application/pdf"
}

function attachmentKind(file: AttachmentFile): string {
  if (isPdf(file)) return "PDF"
  return file.mime.split("/")[1]?.toUpperCase() ?? "FILE"
}

function visualWeight(file: AttachmentFile): number {
  return isImage(file) ? 2 : 1
}

function attachmentColumns(files: AttachmentFile[]): AttachmentFile[][] {
  if (files.length <= 1) return files.length ? [files] : []

  const columns: AttachmentFile[][] = [[], []]
  const weights = [0, 0]

  for (const file of files) {
    const index = weights[0] <= weights[1] ? 0 : 1
    columns[index].push(file)
    weights[index] += visualWeight(file)
  }

  return columns.filter((column) => column.length > 0)
}

export function AttachmentCard(props: { file: AttachmentFile; serverUrl: string }) {
  const dialog = useDialog()
  const url = createMemo(() => resolveUrl(props.serverUrl, props.file))
  const filename = createMemo(() => props.file.filename ?? (isPdf(props.file) ? "file.pdf" : "file"))

  return (
    <Show
      when={isImage(props.file) && url()}
      fallback={
        <a
          data-component="attachment-card"
          data-type={isPdf(props.file) ? "pdf" : "file"}
          href={url() ?? "#"}
          download={isPdf(props.file) ? undefined : filename()}
          target="_blank"
          rel="noopener noreferrer"
        >
          <span data-slot="attachment-card-preview">
            <FileIcon node={{ path: filename(), type: "file" }} />
          </span>
          <span data-slot="attachment-card-body">
            <span data-slot="attachment-card-filename">{filename()}</span>
            <span data-slot="attachment-card-meta">{attachmentKind(props.file)}</span>
          </span>
          <Icon name={isPdf(props.file) ? "scan-eye" : "download"} size="small" />
        </a>
      }
    >
      <button
        type="button"
        data-component="attachment-card"
        data-type="image"
        aria-label={`Preview ${filename()}`}
        title={filename()}
        onClick={() => dialog.show(() => <ImagePreview src={url()!} alt={filename()} />)}
      >
        <img src={url()!} alt={filename()} loading="lazy" />
      </button>
    </Show>
  )
}

export function AttachmentList(props: { files: AttachmentFile[]; serverUrl: string }) {
  const columns = createMemo(() => attachmentColumns(props.files))

  return (
    <Show when={columns().length > 0}>
      <div data-component="tool-attachments" data-columns={columns().length}>
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
