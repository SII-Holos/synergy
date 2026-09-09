import { AttachmentTextExtraction } from "@ericsanchezok/synergy-harness/attachment/text-extraction"
import { Document } from "./util/document"

export function registerDocumentExtraction() {
  AttachmentTextExtraction.register(Document)
}
