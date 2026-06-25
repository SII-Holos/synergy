import type { Accessor } from "solid-js"
import { For } from "solid-js"
import type {
  ImageAttachmentPart,
  NoteAttachmentPart,
  SessionAttachmentPart,
  UploadedAttachmentPart,
} from "@/context/prompt"
import { FileIcon } from "@ericsanchezok/synergy-ui/file-icon"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { useResourceOpen } from "@ericsanchezok/synergy-ui/context/resource-open"

export function PromptAttachments(props: {
  images: Accessor<ImageAttachmentPart[]>
  uploads: Accessor<UploadedAttachmentPart[]>
  notes: Accessor<NoteAttachmentPart[]>
  sessions: Accessor<SessionAttachmentPart[]>
  removeAttachment: (id: string) => void
}) {
  const resourceOpen = useResourceOpen()
  const remove = (event: MouseEvent, id: string) => {
    event.stopPropagation()
    props.removeAttachment(id)
  }

  return (
    <div class="flex flex-wrap gap-2 px-3 pt-3">
      <For each={props.images()}>
        {(attachment) => (
          <div class="relative group">
            <button
              type="button"
              class="relative block size-16 rounded-md overflow-hidden border border-border-base"
              title={attachment.filename}
              onClick={() =>
                resourceOpen?.open({
                  kind: "url",
                  url: attachment.dataUrl,
                  mime: attachment.mime,
                  filename: attachment.filename,
                })
              }
            >
              <img src={attachment.dataUrl} alt={attachment.filename} class="size-full object-cover" />
              <div class="absolute bottom-0 left-0 right-0 px-1 py-0.5 bg-black/50 rounded-b-md">
                <span class="text-10-regular text-white truncate block">{attachment.filename}</span>
              </div>
            </button>
            <button
              type="button"
              onClick={(event) => remove(event, attachment.id)}
              class="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-surface-raised-stronger-non-alpha border border-border-base flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-surface-raised-base-hover"
            >
              <Icon name="x" class="size-3 text-text-weak" />
            </button>
          </div>
        )}
      </For>
      <For each={props.uploads()}>
        {(attachment) => (
          <div class="relative group">
            <button
              type="button"
              class="h-10 rounded-md bg-surface-base flex items-center gap-2 px-2.5 border border-border-base hover:bg-surface-raised-base-hover"
              title={attachment.filename}
              onClick={() =>
                resourceOpen?.open({
                  kind: "url",
                  url: attachment.url,
                  mime: attachment.mime,
                  filename: attachment.filename,
                })
              }
            >
              <FileIcon node={{ path: attachment.filename, type: "file" }} class="shrink-0 size-5" />
              <span class="text-12-medium text-text-base max-w-[160px] truncate">{attachment.filename}</span>
            </button>
            <button
              type="button"
              onClick={(event) => remove(event, attachment.id)}
              class="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-surface-raised-stronger-non-alpha border border-border-base flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-surface-raised-base-hover"
            >
              <Icon name="x" class="size-3 text-text-weak" />
            </button>
          </div>
        )}
      </For>
      <For each={props.notes()}>
        {(attachment) => (
          <div class="relative group">
            <div class="h-10 rounded-md bg-surface-base flex items-center gap-2 px-2.5 border border-border-base">
              <Icon name="notebook-pen" size="small" class="shrink-0 text-text-interactive-base" />
              <span class="text-12-medium text-text-base max-w-[160px] truncate">{attachment.title || "Untitled"}</span>
            </div>
            <button
              type="button"
              onClick={(event) => remove(event, attachment.id)}
              class="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-surface-raised-stronger-non-alpha border border-border-base flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-surface-raised-base-hover"
            >
              <Icon name="x" class="size-3 text-text-weak" />
            </button>
          </div>
        )}
      </For>
      <For each={props.sessions()}>
        {(attachment) => (
          <div class="relative group">
            <div class="h-10 rounded-md bg-surface-base flex items-center gap-2 px-2.5 border border-border-base">
              <Icon name="message-square" size="small" class="shrink-0 text-text-interactive-base" />
              <span class="text-12-medium text-text-base max-w-[180px] truncate">{attachment.title || "Untitled"}</span>
            </div>
            <button
              type="button"
              onClick={(event) => remove(event, attachment.id)}
              class="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-surface-raised-stronger-non-alpha border border-border-base flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-surface-raised-base-hover"
            >
              <Icon name="x" class="size-3 text-text-weak" />
            </button>
          </div>
        )}
      </For>
    </div>
  )
}
