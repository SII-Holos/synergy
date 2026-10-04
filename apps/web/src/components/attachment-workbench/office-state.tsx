import { useLingui } from "@lingui/solid"
import { OfficePreviewError } from "./office-contract"
import { attachmentWorkbench as A } from "@/locales/messages"

export function OfficeNotice() {
  const lingui = useLingui()
  return (
    <div class="office-reader-notice">
      {lingui._({ id: "app.attachment.office.notice", message: "Preview layout may differ from the original file." })}
    </div>
  )
}

export function OfficeErrorState(props: { error: unknown }) {
  const lingui = useLingui()
  const title = () => {
    const code = props.error instanceof OfficePreviewError ? props.error.code : "failed"
    if (code === "too-large") return lingui._(A.tooLarge)
    if (code === "corrupt")
      return lingui._({
        id: "app.attachment.office.corrupt",
        message: "This file is damaged or incomplete. Download the original to check it.",
      })
    if (code === "encrypted")
      return lingui._({
        id: "app.attachment.office.encrypted",
        message: "Encrypted Office files cannot be previewed. Download the original to open it.",
      })
    if (code === "unsupported")
      return lingui._({
        id: "app.attachment.office.unsupported",
        message: "This Office file uses an unsupported format. Download the original to open it.",
      })
    return lingui._(A.unableToPreview)
  }
  return (
    <div class="attachment-workbench-state" role="status">
      <strong>{title()}</strong>
    </div>
  )
}
