import path from "node:path"
import { Attachment } from "@ericsanchezok/synergy-harness/attachment"
import { FileView } from "./view"

export namespace FileAttachment {
  export async function toPart(input: Attachment.PartInput) {
    return Attachment.fromBytes({
      ...input,
      filename: input.filename ?? path.basename(input.filepath),
      localPath: FileView.native() ? input.localPath : undefined,
      bytes: await FileView.bytes(input.filepath),
    })
  }

  export async function extractText(filename: string, mime: string) {
    return Attachment.extractTextFromDataPart({
      filename: path.basename(filename),
      mime,
      url: Attachment.dataUrl(mime, await FileView.bytes(filename)),
    })
  }
}
