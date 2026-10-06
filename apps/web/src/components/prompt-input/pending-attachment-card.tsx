import { Show, createEffect, createSignal, onCleanup } from "solid-js"
import { attachmentKind, formatAttachmentSize } from "@ericsanchezok/synergy-ui/attachment-card"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import type { PendingPromptAttachment } from "./pending-attachments"

export function PendingAttachmentCard(props: {
  entry: PendingPromptAttachment
  uploadingLabel: string
  uploadedLabel: string
  failedLabel: string
  retryLabel: string
  file?: File
  removeLabel: string
  onRemove: (id: string) => void
  onRetry: (id: string) => void
}) {
  const uploading = () => props.entry.status === "uploading"
  const failed = () => props.entry.status === "failed"
  const image = () => props.entry.mime.startsWith("image/")
  const [thumbnail, setThumbnail] = createSignal<string>()
  createEffect(() => {
    const file = props.file
    if (!file || !file.type.startsWith("image/")) {
      setThumbnail(undefined)
      return
    }
    const url = URL.createObjectURL(file)
    setThumbnail(url)
    onCleanup(() => URL.revokeObjectURL(url))
  })
  const metaLabel = () => {
    return [
      attachmentKind({ mime: props.entry.mime }),
      formatAttachmentSize(props.entry.size),
      failed() ? props.failedLabel : uploading() ? props.uploadingLabel : props.uploadedLabel,
    ]
      .filter(Boolean)
      .join(" · ")
  }

  return (
    <div class="prompt-attachment-entry relative group" title={props.entry.filename}>
      <div
        data-component="attachment-card"
        data-type={image() ? "image" : "file"}
        data-size="small"
        data-compact="draft"
        data-disabled="true"
        data-upload-state={props.entry.status}
        aria-busy={uploading()}
        aria-label={image() ? `${props.entry.filename} · ${metaLabel()}` : undefined}
      >
        <span data-slot="attachment-card-preview">
          <Show
            when={thumbnail()}
            fallback={
              <Show when={!uploading()} fallback={<Spinner class="size-4 text-icon-weak-base" />}>
                <Icon name={getSemanticIcon(failed() ? "state.error" : "state.success")} size="small" />
              </Show>
            }
          >
            <img src={thumbnail()} alt={props.entry.filename} class="size-full object-cover" />
          </Show>
        </span>
        <span data-slot="attachment-card-body">
          <Show when={!image()}>
            <span data-slot="attachment-card-filename" class="attachment-compact-filename">
              <span>
                {props.entry.filename.includes(".")
                  ? props.entry.filename.slice(0, props.entry.filename.lastIndexOf("."))
                  : props.entry.filename}
              </span>
              <span>
                {props.entry.filename.includes(".")
                  ? props.entry.filename.slice(props.entry.filename.lastIndexOf("."))
                  : ""}
              </span>
            </span>
          </Show>
          <span data-slot="attachment-card-meta" role="status">
            <Show
              when={!image()}
              fallback={
                <Show when={uploading()} fallback={failed() ? props.failedLabel : props.uploadedLabel}>
                  <Spinner class="size-3" /> {props.uploadingLabel}
                </Show>
              }
            >
              {metaLabel()}
            </Show>
          </span>
          <Show when={failed()}>
            <Show when={!image()}>
              <span class="prompt-attachment-error" title={props.entry.error}>
                {props.entry.error}
              </span>
            </Show>
            <button type="button" data-slot="attachment-retry" onClick={() => props.onRetry(props.entry.id)}>
              {props.retryLabel}
            </button>
          </Show>
        </span>
      </div>
      <button
        type="button"
        aria-label={props.removeLabel}
        onClick={(event) => {
          event.stopPropagation()
          props.onRemove(props.entry.id)
        }}
        class="prompt-attachment-remove"
      >
        <Icon name={getSemanticIcon("action.close")} class="size-3 text-text-weak" />
      </button>
    </div>
  )
}
