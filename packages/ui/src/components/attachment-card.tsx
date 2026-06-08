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

export function AttachmentCard(props: { file: AttachmentFile; serverUrl: string }) {
  const dialog = useDialog()
  const url = createMemo(() => resolveUrl(props.serverUrl, props.file))

  return (
    <Show
      when={props.file.mime.startsWith("image/") && url()}
      fallback={
        <Show
          when={props.file.mime === "application/pdf" && url()}
          fallback={
            <a
              data-component="attachment-card"
              data-type="file"
              href={url() ?? "#"}
              download={props.file.filename ?? "file"}
              target="_blank"
              rel="noopener noreferrer"
            >
              <FileIcon node={{ path: props.file.filename ?? "file", type: "file" }} />
              <span data-slot="attachment-card-filename">{props.file.filename ?? "file"}</span>
              <Icon name="download" size="small" />
            </a>
          }
        >
          <a data-component="attachment-card" data-type="pdf" href={url()!} target="_blank" rel="noopener noreferrer">
            <FileIcon node={{ path: props.file.filename ?? "file.pdf", type: "file" }} />
            <span data-slot="attachment-card-filename">{props.file.filename ?? "file.pdf"}</span>
            <Icon name="scan-eye" size="small" />
          </a>
        </Show>
      }
    >
      <button
        type="button"
        data-component="attachment-card"
        data-type="image"
        aria-label={`Preview ${props.file.filename ?? "image attachment"}`}
        title={props.file.filename ?? "Image attachment"}
        onClick={() => dialog.show(() => <ImagePreview src={url()!} alt={props.file.filename ?? "attachment"} />)}
      >
        <img src={url()!} alt={props.file.filename ?? "attachment"} loading="lazy" />
      </button>
    </Show>
  )
}

export function AttachmentList(props: { files: AttachmentFile[]; serverUrl: string }) {
  return (
    <div data-component="tool-attachments">
      <For each={props.files}>{(file) => <AttachmentCard file={file} serverUrl={props.serverUrl} />}</For>
    </div>
  )
}
