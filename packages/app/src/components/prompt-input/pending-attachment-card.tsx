import { Show } from "solid-js"
import { formatAttachmentSize } from "@ericsanchezok/synergy-ui/attachment-card"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import type { PendingPromptAttachment } from "./pending-attachments"

export function PendingAttachmentCard(props: {
  entry: PendingPromptAttachment
  uploadingLabel: string
  uploadedLabel: string
  removeLabel: string
  onRemove: (id: string) => void
}) {
  const uploading = () => props.entry.status === "uploading"
  const metaLabel = () => {
    if (!uploading()) return props.uploadedLabel
    return [formatAttachmentSize(props.entry.size), props.uploadingLabel].filter(Boolean).join(" · ")
  }

  return (
    <div class="relative group w-56 max-w-full">
      <div
        data-component="attachment-card"
        data-type="file"
        data-size="small"
        data-disabled="true"
        data-upload-state={props.entry.status}
        aria-busy={uploading()}
      >
        <span data-slot="attachment-card-preview">
          <Show when={!uploading()} fallback={<Spinner class="size-4 text-icon-weak-base" />}>
            <Icon name={getSemanticIcon("state.success")} size="small" class="text-icon-success-base" />
          </Show>
        </span>
        <span data-slot="attachment-card-body">
          <span data-slot="attachment-card-filename">{props.entry.filename}</span>
          <span data-slot="attachment-card-meta">{metaLabel()}</span>
        </span>
      </div>
      <button
        type="button"
        aria-label={props.removeLabel}
        onClick={(event) => {
          event.stopPropagation()
          props.onRemove(props.entry.id)
        }}
        class="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-surface-raised-stronger-non-alpha border border-border-base flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-surface-raised-base-hover"
      >
        <Icon name={getSemanticIcon("action.close")} class="size-3 text-text-weak" />
      </button>
    </div>
  )
}
