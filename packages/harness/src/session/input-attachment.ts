import path from "node:path"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { z } from "zod"
import { Attachment } from "../attachment"
import { Asset } from "../asset/asset"
import { Identifier } from "../id/id"
import { Scope } from "../scope"
import type { MessageV2 } from "./message-v2"
import { findRecordingError, isTransientStorageError } from "./rollout/error"

export const AttachmentPreparationError = NamedError.create(
  "AttachmentPreparationError",
  z.object({ filename: z.string(), message: z.string() }),
)

export function shouldExtractAttachmentText(part: Pick<MessageV2.AttachmentPart, "model">) {
  return !part.model || (part.model.mode === "content" && part.model.text === undefined)
}

export function attachmentPreparationError(part: { filename?: string }, cause: unknown): unknown {
  if (
    findRecordingError(cause) ||
    isTransientStorageError(cause) ||
    cause instanceof DOMException ||
    AttachmentPreparationError.isInstance(cause)
  )
    return cause
  const filename = path.basename(part.filename ?? "attachment").replace(/[\r\n\x00-\x1f]/g, "") || "attachment"
  const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined
  const reason =
    cause instanceof Attachment.InvalidUrlError
      ? "its URL is invalid"
      : code === "ENOENT"
        ? "its source is missing"
        : Scope.WorkspaceRequiredError.isInstance(cause)
          ? "the local file requires a workspace; upload it as an attachment instead"
          : "its content could not be read or processed"
  return new AttachmentPreparationError(
    {
      filename,
      message: `Could not prepare ${filename}: ${reason}. The message was not sent. Retry or replace the attachment.`,
    },
    { cause },
  )
}

export async function prepareManagedAttachment(
  part: MessageV2.AttachmentPart,
  filepath?: string,
): Promise<MessageV2.Part[]> {
  const bytes = filepath ? await Bun.file(filepath).bytes() : Attachment.decodeDataUrl(part.url).buffer
  const localPath = filepath ?? Asset.resolvePath(await Asset.write(Buffer.from(bytes), part.mime, part.filename))!
  const attachment = {
    ...(await Attachment.fromBytes({ ...part, bytes, localPath })),
    artifact: part.artifact,
  }
  if (!shouldExtractAttachmentText(part)) return [attachment]
  const policy = Attachment.policy({ filename: part.filename, filepath: localPath, mime: part.mime })
  const text = Attachment.isText(part.mime)
    ? new TextDecoder("utf-8").decode(bytes)
    : policy.extractText
      ? await Attachment.extractTextFromFile(localPath)
      : undefined
  if (text === undefined) return [attachment]
  return [
    {
      id: Identifier.ascending("part"),
      messageID: part.messageID,
      sessionID: part.sessionID,
      type: "text",
      origin: "system",
      text: `Contents of ${part.filename ?? path.basename(localPath)}:\n${text}`,
    },
    ...(Attachment.isText(part.mime) || !policy.extractText || policy.keepBinary ? [attachment] : []),
  ]
}
