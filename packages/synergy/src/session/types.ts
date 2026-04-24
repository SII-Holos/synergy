import z from "zod"
import { Identifier } from "@/id/id"
import type { Scope } from "@/scope/types"
import { Snapshot } from "@/session/snapshot"
import { PermissionNext } from "@/permission/next"
import { SessionInteraction } from "@/session/interaction"
import { opaque } from "@/util/schema"
import { SessionEndpoint } from "./endpoint"

const ScopeField = opaque<Scope>(
  z.object({
    id: z.string(),
    type: z.string().optional(),
    directory: z.string().optional(),
    worktree: z.string().optional(),
    vcs: z.literal("git").optional(),
    name: z.string().optional(),
    icon: z.object({ url: z.string().optional(), color: z.string().optional() }).optional(),
    time: z.object({ created: z.number(), updated: z.number(), initialized: z.number().optional() }).optional(),
    sandboxes: z.array(z.string()).optional(),
  }),
  { ref: "SessionScope" },
)

export const Info = z
  .preprocess(
    (data: any) => {
      if (data && typeof data === "object") {
        if (data.projectID && !data.scopeID) {
          data.scopeID = data.projectID
          delete data.projectID
        }
      }
      return data
    },
    z.object({
      id: Identifier.schema("session"),
      scope: ScopeField,
      parentID: Identifier.schema("session").optional(),
      endpoint: SessionEndpoint.Info.optional(),
      summary: z
        .object({
          additions: z.number(),
          deletions: z.number(),
          files: z.number(),
          diffs: Snapshot.FileDiff.array().optional(),
        })
        .optional(),
      title: z.string(),
      version: z.string(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
        compacting: z.number().optional(),
        archived: z.number().optional(),
      }),
      pinned: z.number().optional(),
      permission: PermissionNext.Ruleset.optional(),
      pendingReply: z.boolean().optional(),
      allowAll: z.boolean().optional(),
      interaction: SessionInteraction.Info.optional(),
      agenda: z
        .object({
          itemID: z.string(),
        })
        .optional(),
      lastExchange: z
        .object({
          user: z.string().optional(),
          assistant: z.string().optional(),
        })
        .optional(),
      revert: z
        .object({
          messageID: z.string(),
          partID: z.string().optional(),
          snapshot: z.string().optional(),
          diff: z.string().optional(),
        })
        .optional(),
    }),
  )
  .meta({
    ref: "Session",
  })
export type Info = z.output<typeof Info>

export const StatusInfo = z
  .union([
    z.object({
      type: z.literal("idle"),
    }),
    z.object({
      type: z.literal("retry"),
      attempt: z.number(),
      message: z.string(),
      next: z.number(),
    }),
    z.object({
      type: z.literal("busy"),
      description: z.string().optional(),
    }),
  ])
  .meta({
    ref: "SessionStatus",
  })
export type StatusInfo = z.infer<typeof StatusInfo>
