import { z } from "zod"
import { SessionSchemaRegistry } from "./schema-registry"

export interface SessionExtensionShape {}
export interface SessionCreationExtensions {
  tags?: string[]
}
export const SESSION_TAG_MAX_LENGTH = 40
export const SESSION_TAG_MAX_COUNT = 20

export function normalizeSessionTags(values: unknown): string[] {
  return Tags.parse(values === undefined ? [] : values)
}

export function normalizeSessionTag(value: unknown): string | undefined {
  const parsed = TagQuery.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export const TagQuery = z
  .string()
  .trim()
  .transform((value) => value.replace(/^(?:#\s*)+/, ""))
  .pipe(z.string().min(1).max(SESSION_TAG_MAX_LENGTH))
  .meta({ ref: "SessionTagQuery" })

export const Tags = z
  .array(z.string())
  .transform((values, context) => {
    const tags: string[] = []
    values.forEach((value, index) => {
      const parsed = TagQuery.safeParse(value)
      if (!parsed.success) {
        const tooLong = parsed.error.issues.some((issue) => issue.code === z.ZodIssueCode.too_big)
        if (!tooLong) return
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: "Session tags must be at most 40 characters after removing a leading hash",
        })
        return
      }
      tags.push(parsed.data)
    })
    return [...new Set(tags)]
  })
  .refine((tags) => tags.every((tag) => tag.length <= SESSION_TAG_MAX_LENGTH), {
    message: `Session tags can be at most ${SESSION_TAG_MAX_LENGTH} characters`,
  })
  .refine((tags) => tags.length <= SESSION_TAG_MAX_COUNT, {
    message: `Sessions can have at most ${SESSION_TAG_MAX_COUNT} tags`,
  })
  .meta({ ref: "SessionTags" })

import { Identifier } from "../id/id"
import type { Scope } from "../scope/types"
import { SnapshotSchema } from "./snapshot-schema"
import { PermissionNext } from "../permission/next"
import { SessionInteraction } from "./interaction"
import { Runtime as ScopeRuntime } from "../scope/types"
import { SessionEndpoint } from "./endpoint"
import { SessionCortexContract as CortexTypes } from "./cortex-contract"
import { Workspace } from "./workspace-schema"

export { Workspace }
const ScopeField = ScopeRuntime.meta({ ref: "SessionScope" })

const CortexDelegationInfoInner = z.object({
  taskID: z.string(),
  parentSessionID: z.string(),
  parentMessageID: z.string(),
  description: z.string(),
  agent: z.string(),
  executionRole: z.enum(["primary", "delegated_subagent"]).optional(),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  settledAt: z.number().optional(),
  status: z.enum(["queued", "running", "completed", "error", "cancelled", "interrupted"]),
  model: z
    .object({
      providerID: z.string(),
      modelID: z.string(),
    })
    .optional(),
  error: z.string().optional(),
  launchFailure: z.boolean().optional(),
  notifyParentOnComplete: z.boolean().optional(),
  deliveryNotifiedAt: z.number().optional(),
  visibility: z.enum(["visible", "hidden"]).optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
  outputConfig: CortexTypes.OutputConfig.optional(),
  output: CortexTypes.TaskOutput.optional(),
  owner: CortexTypes.PluginTaskOwner.optional(),
  timeoutMs: z.number().int().positive().optional(),
  usage: CortexTypes.TaskUsage.optional(),
})

export const CortexDelegationInfo = CortexDelegationInfoInner.meta({ ref: "SessionCortexDelegation" })
export type CortexDelegationInfo = z.infer<typeof CortexDelegationInfoInner>

const ControlProfileId = z.enum(["guarded", "autonomous", "full_access"])

export const HistoryInfo = z
  .object({
    rollback: z
      .object({
        id: Identifier.schema("history"),
        numTurns: z.number(),
        created: z.number(),
        messageID: Identifier.schema("message").optional(),
        droppedMessageIDs: z.array(Identifier.schema("message")),
        droppedUserMessageIDs: z.array(Identifier.schema("message")),
        cutMessageID: Identifier.schema("message").optional(),
        files: z.array(z.string()),
        patchPartIDs: z.array(Identifier.schema("part")),
        canUnrollback: z.boolean(),
      })
      .optional(),
  })
  .meta({ ref: "SessionHistoryInfo" })
export type HistoryInfo = z.infer<typeof HistoryInfo>

/** Why a session is `paused`. A pause is the single intermediate state for every
 * abnormal end, so the reason carries the cause through to clients instead of
 * collapsing unrelated failures into one opaque status. The session itself is
 * the only pause authority; workflow state never produces one. */
export const PausedReason = z
  .enum(["aborted", "failed", "interrupted", "workflow"])
  .meta({ ref: "SessionPausedReason" })
export type PausedReason = z.infer<typeof PausedReason>

/** The durable pause latch on a session. Present means the session is stopped
 * mid-work and will not be driven again until the user continues, abandons, or
 * sends new input. */
export const PausedInfo = z
  .object({
    reason: PausedReason,
    description: z.string().optional(),
    since: z.number(),
  })
  .meta({ ref: "SessionPaused" })
export type PausedInfo = z.infer<typeof PausedInfo>

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
      status: z.literal("paused"),
      reason: PausedReason,
      description: z.string().optional(),
      since: z.number(),
    }),
  ])
  .meta({ ref: "SessionWorkingInfo" })
export type WorkingInfo = z.infer<typeof WorkingInfo>

export const RollbackAck = z
  .object({
    rollbackID: Identifier.schema("history"),
    acknowledgedAt: z.number(),
  })
  .meta({ ref: "SessionRollbackAck" })
export type RollbackAck = z.infer<typeof RollbackAck>

export const CompletionNotice = z
  .object({
    unread: z.boolean(),
    unreadCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    silent: z.boolean(),
  })
  .meta({ ref: "SessionCompletionNotice" })
export type CompletionNotice = z.infer<typeof CompletionNotice>

const BaseInfo = z.preprocess(
  (data: any) => {
    if (data && typeof data === "object") {
      if (data.projectID && !data.scopeID) {
        data.scopeID = data.projectID
        delete data.projectID
      }
      if (data.completionNotice && typeof data.completionNotice === "object") {
        const notice = data.completionNotice as Record<string, unknown>
        if (notice.unreadCount === undefined) {
          notice.unreadCount = notice.unread === true && notice.silent !== true ? 1 : 0
        }
      }
    }
    return data
  },
  z.object({
    id: Identifier.schema("session"),
    scope: ScopeField,
    parentID: Identifier.schema("session").optional(),
    forkedFrom: z
      .object({
        sessionID: Identifier.schema("session"),
        messageID: Identifier.schema("message").optional(),
        title: z.string().optional(),
      })
      .optional(),
    category: z.enum(["project", "home", "channel", "background", "github"]).optional(),
    tags: Tags.default([]),
    provenance: z.literal("github").optional(),
    endpoint: SessionEndpoint.Info.optional(),
    summary: z
      .object({
        additions: z.number(),
        deletions: z.number(),
        files: z.number(),
        diffs: SnapshotSchema.FileDiff.array().optional(),
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
    preAuthorizedActions: z
      .array(z.string())
      .optional()
      .describe(
        "Tool names pre-authorized by the user via system scheduling (e.g. agenda wake). Bypasses the ask gate for these tools within this session only.",
      ),
    toolState: z
      .object({
        expandedGroups: z.array(z.string()).optional(),
        activatedTools: z.array(z.string()).optional(),
      })
      .optional(),
    completionNotice: CompletionNotice.default(() => ({ unread: false, unreadCount: 0, silent: false })),
    modelOverride: z
      .object({
        providerID: z.string(),
        modelID: z.string(),
      })
      .optional()
      .describe("Per-session model override set by /model command"),
    agentOverride: z.string().optional().describe("Per-session agent override set by session control"),
    paused: PausedInfo.optional(),
    interaction: SessionInteraction.Info.optional(),
    lastExchange: z
      .object({
        user: z.string().optional(),
        assistant: z.string().optional(),
      })
      .optional(),
    history: HistoryInfo.optional(),
    rollbackAck: RollbackAck.optional(),
    cortex: CortexDelegationInfo.optional(),
    working: WorkingInfo.optional(),
    workspace: Workspace.nullable(),
    workspaceID: z.string().nullable().optional(),
    workspaceError: z.string().optional(),
    workflow: z
      .object({
        kind: z.string(),
        extension: z.object({ kind: z.string() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
  }),
)

export const Info = BaseInfo.in.pipe(SessionSchemaRegistry.compose(BaseInfo.out)).meta({ ref: "Session" })
export type Info = z.infer<typeof Info>

export const PersistedInfo = BaseInfo.in.pipe(BaseInfo.out.omit({ workflow: true }).passthrough())
export type PersistedInfo = z.infer<typeof PersistedInfo>
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
      type: z.literal("paused"),
      reason: PausedReason,
      description: z.string().optional(),
      since: z.number(),
    }),
  ])
  .meta({
    ref: "SessionStatus",
  })
export type StatusInfo = z.infer<typeof StatusInfo>
