import { createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { useDialog } from "../context/dialog"
import { useResourceOpen } from "../context/resource-open"
import { FileIcon } from "./file-icon"
import { Icon } from "./icon"
import { ImagePreview } from "./image-preview"
import {
  artifactColumns,
  artifactMeta,
  isHtmlArtifact,
  isImageArtifact,
  isPdfArtifact,
  resolveArtifactUrl,
  type ArtifactFile,
} from "./artifact-card-utils"
export type { ArtifactFile, AttachmentFile } from "./artifact-card-utils"
export {
  artifactColumnCount,
  artifactColumns,
  artifactKind,
  formatArtifactSize,
  isImageArtifact,
  joinServerUrl,
  resolveArtifactUrl,
} from "./artifact-card-utils"

export function ArtifactCard(props: { file: ArtifactFile; serverUrl: string }) {
  const dialog = useDialog()
  const resourceOpen = useResourceOpen()
  const [imageFailed, setImageFailed] = createSignal(false)
  const url = createMemo(() => resolveArtifactUrl(props.serverUrl, props.file))
  const filename = createMemo(() => props.file.filename ?? (isPdfArtifact(props.file) ? "file.pdf" : "file"))
  const meta = createMemo(() => artifactMeta(props.file))
  const openArtifact = () => {
    if (resourceOpen?.openArtifact(props.file, { serverUrl: props.serverUrl })) return
    const href = url()
    if (!href) return
    if (isImageArtifact(props.file)) {
      dialog.show(() => <ImagePreview src={href} alt={filename()} />)
      return
    }
    window.open(href, "_blank", "noopener,noreferrer")
  }

  return (
    <Show
      when={isImageArtifact(props.file) && url() && !imageFailed()}
      fallback={
        <DynamicArtifactLink
          url={url()}
          filename={filename()}
          type={isPdfArtifact(props.file) ? "pdf" : "file"}
          downloadable={!isPdfArtifact(props.file) && !isHtmlArtifact(props.file)}
          onOpen={resourceOpen ? openArtifact : undefined}
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
              name={isPdfArtifact(props.file) || isHtmlArtifact(props.file) ? "scan-eye" : "download"}
              size="small"
            />
          </Show>
        </DynamicArtifactLink>
      }
    >
      <button
        type="button"
        data-component="attachment-card"
        data-type="image"
        aria-label={`Preview ${filename()}`}
        title={filename()}
        onClick={openArtifact}
      >
        <img src={url()!} alt={filename()} loading="lazy" onError={() => setImageFailed(true)} />
      </button>
    </Show>
  )
}

function DynamicArtifactLink(props: {
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

export function ArtifactGallery(props: { files: ArtifactFile[]; serverUrl: string; variant?: "default" | "result" }) {
  const columns = createMemo(() => artifactColumns(props.files))

  return (
    <Show when={columns().length > 0}>
      <div data-component="artifact-gallery" data-columns={columns().length} data-variant={props.variant ?? "default"}>
        <div data-slot="attachment-column-layout">
          <For each={columns()}>
            {(column) => (
              <div data-slot="attachment-column">
                <For each={column}>{(file) => <ArtifactCard file={file} serverUrl={props.serverUrl} />}</For>
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  )
}

export const AttachmentCard = ArtifactCard
export const AttachmentList = ArtifactGallery
