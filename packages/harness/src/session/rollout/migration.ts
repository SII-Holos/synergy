import path from "node:path"
import { pathToFileURL } from "node:url"
import { realpath } from "node:fs/promises"
import z from "zod"
import { Global } from "../../global"
import { Identifier } from "../../id/id"
import { Storage } from "../../storage/storage"
import { StoragePath } from "../../storage/path"
import type { Migration } from "../../migration/types"
import { MessageV2 } from "../message-v2"
import { CortexDelegationInfo } from "../types"
import { Attachment } from "../../attachment"
import { RolloutArtifact } from "./artifact"
import { RolloutAttachment } from "./attachment"
import type { RolloutSchema } from "./schema"

export namespace RolloutMigration {
  // Archived session metadata is historical evidence; validate only the settlement fields this migration owns.
  const SettlementRecord = z
    .object({
      cortex: CortexDelegationInfo.pick({ status: true, settledAt: true }).passthrough().optional(),
    })
    .passthrough()
  const Audit = z
    .object({
      version: z.literal(1),
      completedAt: z.number(),
      legacyMessages: z.number(),
      restoredOutputs: z.number(),
      missing: z.array(z.string()),
      requests: z.literal("historical_requests_not_recorded"),
    })
    .strict()
  const options = { private: true, durable: true, compact: true } as const

  async function retainedOutput(filepath: unknown) {
    if (typeof filepath !== "string") return undefined
    try {
      const [directory, target] = await Promise.all([realpath(Global.Path.toolOutput), realpath(filepath)])
      if (path.dirname(target) !== directory || !path.basename(target).startsWith("tool_")) return undefined
      return target
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
      throw error
    }
  }

  export async function session(owner: RolloutSchema.Owner) {
    if (owner.kind !== "session") throw new Error("Session migration requires a session owner")
    const key = [...RolloutArtifact.root(owner), "history"]
    const previous = await Storage.read(key).catch((error) => {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    })
    if (previous) return Audit.parse(previous)
    const audit: z.infer<typeof Audit> = {
      version: 1,
      completedAt: Date.now(),
      legacyMessages: 0,
      restoredOutputs: 0,
      missing: [],
      requests: "historical_requests_not_recorded",
    }
    const scopeID = Identifier.asScopeID(owner.scopeID),
      sessionID = Identifier.asSessionID(owner.sessionID)
    const infoKey = StoragePath.sessionInfo(scopeID, sessionID)
    const info = SettlementRecord.parse(await Storage.read(infoKey))
    for (const messageID of await Storage.scan(StoragePath.sessionMessagesRoot(scopeID, sessionID), { strict: true })) {
      const mid = Identifier.asMessageID(messageID)
      const infoKey = StoragePath.messageInfo(scopeID, sessionID, mid)
      const raw = await Storage.read(infoKey)
      const parsed = MessageV2.Info.safeParse(raw)
      if (!parsed.success) {
        audit.missing.push(`message:${messageID}:invalid_legacy_record`)
        continue
      }
      if (parsed.data.role === "assistant" && !parsed.data.accounting) {
        await Storage.write(
          infoKey,
          { ...parsed.data, accounting: { kind: "legacy", calculation: "session-v0" } },
          options,
        )
        audit.legacyMessages++
      } else if (parsed.data.role === "assistant" && parsed.data.accounting?.kind === "legacy") audit.legacyMessages++
      for (const partID of await Storage.scan(StoragePath.messageParts(scopeID, sessionID, mid), { strict: true })) {
        const partKey = StoragePath.messagePart(scopeID, sessionID, mid, Identifier.asPartID(partID))
        const parsed = MessageV2.Part.safeParse(await Storage.read(partKey))
        if (!parsed.success) {
          audit.missing.push(`part:${partID}:invalid_legacy_record`)
          continue
        }
        let part = parsed.data
        if (part.type === "tool" && part.state.status === "completed") {
          const state = part.state
          if (state.outputArtifact) {
            if (state.metadata.rolloutLegacyOutput === "retained_file") audit.restoredOutputs++
          } else {
            const filepath = await retainedOutput(state.metadata.outputPath)
            if (filepath) {
              const attachment = await RolloutAttachment.capture(
                owner,
                { url: pathToFileURL(filepath).href, mime: "text/plain;charset=utf-8" },
                { allowFile: true },
              )
              part = {
                ...part,
                state: {
                  ...state,
                  outputArtifact: attachment.artifact,
                  metadata: { ...state.metadata, rolloutLegacyOutput: "retained_file" },
                },
              }
              audit.restoredOutputs++
            } else if (state.time.compacted || state.metadata.truncated || state.metadata.rolloutImportMissingOutput) {
              audit.missing.push(`tool:${partID}:original_not_recoverable`)
              part = { ...part, state: { ...state, metadata: { ...state.metadata, rolloutLegacyOutput: "missing" } } }
            } else {
              part = {
                ...part,
                state: {
                  ...state,
                  outputArtifact: await RolloutArtifact.writeText(owner, state.output),
                  metadata: { ...state.metadata, rolloutLegacyOutput: "message_observation" },
                },
              }
            }
          }
        }
        const attachments =
          part.type === "attachment"
            ? [part]
            : part.type === "tool" && part.state.status === "completed"
              ? (part.state.attachments ?? [])
              : []
        for (const attachment of attachments) {
          if (attachment.artifact) continue
          if (attachment.url.startsWith("data:") || attachment.url.startsWith("asset:")) {
            const captured = await RolloutAttachment.capture(owner, attachment).catch((error: unknown) => {
              if (
                !(error instanceof Attachment.InvalidUrlError) &&
                !(error instanceof Error && "code" in error && error.code === "ENOENT")
              )
                throw error
              return undefined
            })
            if (!captured?.artifact) {
              audit.missing.push(`attachment:${attachment.id}:original_not_recoverable`)
              continue
            }
            Object.assign(attachment, captured)
            await Storage.write(partKey, part, options)
          } else if (attachment.mime !== "application/x-directory")
            audit.missing.push(`attachment:${attachment.id}:original_not_recorded`)
        }
        if (part !== parsed.data) await Storage.write(partKey, part, options)
      }
    }
    if (info.cortex && !["queued", "running"].includes(info.cortex.status) && !info.cortex.settledAt) {
      await Storage.write(infoKey, { ...info, cortex: { ...info.cortex, settledAt: audit.completedAt } }, options)
      audit.missing.push("cortex:historical_delivery_not_verified")
    }
    await Storage.write(key, audit, options)
    return audit
  }

  export const migration: Migration = {
    id: "20260907-session-rollout-evidence",
    description: "Preserve legacy accounting and retained tool evidence with explicit historical gaps",
    dependsOn: ["20260828-session-nav-timestamps"],
    async up(progress) {
      const owners: RolloutSchema.Owner[] = []
      for (const scopeID of await Storage.scan(["sessions"], { strict: true }))
        for (const sessionID of await Storage.scan(["sessions", scopeID], { strict: true }))
          owners.push({ kind: "session", scopeID, sessionID })
      for (let index = 0; index < owners.length; index++) {
        await session(owners[index])
        progress(index + 1, owners.length)
      }
      await Storage.removeTree(StoragePath.statsRoot())
    },
  }
}
