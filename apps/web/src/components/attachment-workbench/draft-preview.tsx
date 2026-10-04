import { createEffect } from "solid-js"
import type { AttachmentFile } from "@ericsanchezok/synergy-ui/attachment-card"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { useLingui } from "@lingui/solid"
import { usePlatform } from "@/context/platform"
import { AttachmentPreview } from "./preview"

export function DraftAttachmentPreview(props: {
  file: AttachmentFile
  serverUrl: string
  isValid: () => boolean
  onInvalid: () => void
}) {
  const platform = usePlatform()
  const lingui = useLingui()
  createEffect(() => {
    if (!props.isValid()) props.onInvalid()
  })
  return (
    <Dialog
      size="wide"
      class="draft-attachment-dialog"
      title={lingui._({ id: "prompt.attachments.previewTitle", message: "Attachment preview" })}
    >
      <AttachmentPreview
        file={props.file}
        serverUrl={props.serverUrl}
        fetcher={platform.fetch}
        onOpenExternal={platform.openLink}
      />
    </Dialog>
  )
}
