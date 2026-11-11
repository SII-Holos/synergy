import { OrganizationSyncProtocol as Sync } from "@ericsanchezok/synergy-organization-protocol"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { RolloutArtifact } from "@ericsanchezok/synergy-harness/session/rollout/artifact"
import { SecretMask } from "@ericsanchezok/synergy-harness/secrets/mask"
import { z } from "zod"

export async function projectSharedPart(part: MessageV2.Part, owner: RolloutArtifact.Owner) {
  const blobs: RolloutArtifact.Ref[] = []
  async function content(value: string): Promise<Sync.Content> {
    const text = await SecretMask.apply(value)
    if (Buffer.byteLength(text) <= 64 * 1024) return { kind: "inline", text }
    const artifact = await RolloutArtifact.writeText(owner, text)
    if (!artifact.sha256) throw new Error("Shared content is missing its immutable digest")
    blobs.push(artifact)
    return {
      kind: "blob",
      blobID: artifact.id,
      hash: artifact.sha256,
      bytes: artifact.bytes,
      mediaType: artifact.mediaType,
    }
  }
  let projected: Sync.TranscriptPart | undefined
  switch (part.type) {
    case "text":
      projected = {
        type: "text",
        content: await content(part.text),
        origin: MessageV2.isSystemPart(part) ? "system" : "user",
      }
      break
    case "reasoning":
      projected = { type: "reasoning", content: await content(part.text), time: part.time }
      break
    case "tool": {
      const state = part.state
      const input =
        state.status === "pending" || state.status === "generating" ? state.raw : JSON.stringify(state.input)
      let metadata: z.infer<typeof Sync.KnowledgeToolMetadata> | undefined
      if (part.tool === "organization_knowledge" && "metadata" in state && state.metadata) {
        const fields = Object.fromEntries(
          await Promise.all(
            Object.entries(state.metadata)
              .filter(([key]) => Object.hasOwn(Sync.KnowledgeToolMetadata.shape, key))
              .map(async ([key, value]) => [key, typeof value === "string" ? await SecretMask.apply(value) : value]),
          ),
        )
        const parsed = Sync.KnowledgeToolMetadata.safeParse(fields)
        if (parsed.success) metadata = parsed.data
      }
      projected = {
        type: "tool",
        callID: part.callID,
        tool: part.tool,
        status: state.status,
        input: await content(input),
        ...(state.status === "completed" ? { output: await content(state.output) } : {}),
        ...(state.status === "error" ? { error: await content(state.error) } : {}),
        ...("title" in state && state.title ? { title: (await SecretMask.apply(state.title)).slice(0, 1024) } : {}),
        ...("time" in state ? { startedAt: state.time.start } : {}),
        ...("time" in state && "end" in state.time ? { completedAt: state.time.end } : {}),
        ...(metadata ? { metadata } : {}),
      }
      break
    }
    case "attachment":
      projected = {
        type: "attachment",
        filename: (part.filename ?? "attachment").split(/[\\/]/).at(-1) || "attachment",
        mediaType: part.mime,
        ...(part.artifact?.sha256 ? { hash: part.artifact.sha256, bytes: part.artifact.bytes } : {}),
      }
      break
    case "step-start":
      projected = { type: "step-start" }
      break
    case "step-finish":
      projected = { type: "step-finish", reason: part.reason, cost: part.cost, tokens: part.tokens }
      break
    case "compaction":
      projected = { type: "compaction", auto: part.auto }
      break
    case "compaction_recovery":
      projected = { type: "notice", kind: "compaction-recovery", content: await content(part.summary) }
      break
    case "retry":
      projected = { type: "notice", kind: "retry", content: await content(part.error.name) }
      break
  }
  return { part: projected && Sync.TranscriptPart.parse(projected), blobs }
}
