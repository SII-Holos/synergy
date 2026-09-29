import { RolloutLedger } from "./ledger"
import type { RolloutSchema } from "./schema"
import type { InputImages } from "./input-images"

export async function readImageInputReceipt(identity: {
  owner: RolloutSchema.Owner
  runID: string
  callID: string
}): Promise<InputImages.Receipt> {
  const call = await RolloutLedger.getCall(identity.owner, identity.runID, identity.callID)
  const attempts = await RolloutLedger.attempts(identity.owner, identity.runID, identity.callID)
  const attempt = attempts.at(-1)
  const submitted =
    attempt?.request.status === "complete" && attempt.timing?.sentAt !== undefined
      ? new Set(attempt.requestImages ?? [])
      : new Set<string>()
  return {
    callID: call.id,
    providerID: call.model.providerID,
    modelID: call.model.modelID,
    recorded: attempt?.inputImages !== undefined,
    images: (attempt?.inputImages ?? []).map((image) => ({
      sha256: image.sha256,
      stage: image.status === "omitted" ? "omitted" : submitted.has(image.sha256) ? "submitted" : "included",
      ...(image.reason ? { reason: image.reason } : {}),
    })),
  }
}

export type ImageAttachmentSource = { messageID: string; partID: string; attachmentID: string; sha256: string }
export async function publishImageInputReceipt(
  sessionID: string,
  sources: ImageAttachmentSource[],
  receipt: InputImages.Receipt,
) {
  const { MessageV2 } = await import("../message-v2")
  const { Session } = await import("..")
  const entries = new Map(receipt.images.map((image) => [image.sha256, image]))
  for (const messageID of new Set(sources.map((source) => source.messageID))) {
    const parts = await MessageV2.parts({ sessionID, messageID })
    for (const part of parts) {
      if (part.type !== "tool" || part.state.status !== "completed" || !part.state.attachments?.length) continue
      const selected = sources.filter((source) => source.messageID === messageID && source.partID === part.id)
      if (!selected.length) continue
      let changed = false
      const attachments = part.state.attachments.map((attachment) => {
        const source = selected.find((source) => source.attachmentID === attachment.id)
        if (!source || attachment.metadata?.imageInput?.sha256 !== source.sha256) return attachment
        const entry =
          entries.get(source.sha256) ??
          (receipt.recorded ? { sha256: source.sha256, stage: "omitted", reason: "not_in_model_input" } : undefined)
        if (!entry) return attachment
        changed = true
        return {
          ...attachment,
          metadata: {
            ...attachment.metadata,
            imageInput: {
              ...attachment.metadata.imageInput,
              ...entry,
              callID: receipt.callID,
              providerID: receipt.providerID,
              modelID: receipt.modelID,
            },
          },
        }
      })
      if (changed) await Session.updatePart({ ...part, state: { ...part.state, attachments } })
    }
  }
}
