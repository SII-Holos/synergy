import z from "zod"
import { Identifier } from "@/id/id"
import type { Scope } from "@/scope/types"
import { Snapshot } from "@/session/snapshot"
import { PermissionNext } from "@/permission/next"
import { SessionInteraction } from "@/session/interaction"
import { opaque } from "@/util/schema"
import { SessionEndpoint } from "./endpoint"

// Workspace metadata intentionally allows extra fields so future workspace
// implementations can carry type-specific data without breaking old sessions.
export const Workspace = z
  .object({
    type: z.string(),
    path: z.string(),
    scopeID: z.string(),
  })
  .passthrough()
  .meta({ ref: "SessionWorkspace" })
export type Workspace = z.infer<typeof Workspace>
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

const CortexDelegationInfoInner = z.object({
  parentSessionID: z.string(),
  parentMessageID: z.string(),
  description: z.string(),
  agent: z.string(),
  executionRole: z.enum(["primary", "delegated_subagent"]).optional(),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  status: z.enum(["queued", "running", "completed", "error", "cancelled"]),
  model: z
    .object({
      providerID: z.string(),
      modelID: z.string(),
    })
    .optional(),
  result: z.string().optional(),
  error: z.string().optional(),
})

export const CortexDelegationInfo = CortexDelegationInfoInner.meta({ ref: "SessionCortexDelegation" })
export type CortexDelegationInfo = z.infer<typeof CortexDelegationInfoInner>

const ControlProfileId = z.enum(["manual", "guarded", "autonomous", "full_access"])

export const WorkingInfo = z
  .union([
    z.object({
      status: z.literal("busy"),
      description: z.string().optional(),
    }),
    z.object({
      status: z.literal("retry"),
      attempt: z.number(),
      message: z.string(),
      next: z.number(),
    }),
    z.object({
      status: z.literal("recovering"),
    }),
  ])
  .meta({ ref: "SessionWorkingInfo" })
export type WorkingInfo = z.infer<typeof WorkingInfo>

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
      category: z.enum(["project", "home", "channel", "background"]).optional(),
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
      controlProfile: ControlProfileId.optional(),
      pendingReply: z.boolean().optional(),
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
      cortex: CortexDelegationInfo.optional(),
      working: WorkingInfo.optional(),
      workspace: Workspace.optional(),
    }),
  )
  .meta({
    ref: "Session",
  })

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
    z.object({
      type: z.literal("recovering"),
      description: z.string().optional(),
    }),
  ])
  .meta({
    ref: "SessionStatus",
  })
export type StatusInfo = z.infer<typeof StatusInfo>
