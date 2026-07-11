import z from "zod"
import { Identifier } from "@/id/id"
import type { Scope } from "@/scope/types"
import { SnapshotSchema } from "@/session/snapshot-schema"
import { PermissionNext } from "@/permission/next"
import { SessionInteraction } from "@/session/interaction"
import { opaque } from "@/util/schema"
import { SessionEndpoint } from "./endpoint"
import { CortexTypes } from "@/cortex/types"

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
  taskID: z.string(),
  parentSessionID: z.string(),
  parentMessageID: z.string(),
  description: z.string(),
  agent: z.string(),
  executionRole: z.enum(["primary", "delegated_subagent"]).optional(),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  status: z.enum(["queued", "running", "completed", "error", "cancelled", "interrupted"]),
  model: z
    .object({
      providerID: z.string(),
      modelID: z.string(),
    })
    .optional(),
  error: z.string().optional(),
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

export const SuperPlanSessionInfo = z
  .object({
    runID: Identifier.schema("superplan_run"),
    role: z.enum(["planner", "node", "merge", "audit"]),
    nodeID: Identifier.schema("superplan_node").optional(),
    mergeID: Identifier.schema("superplan_merge").optional(),
  })
  .meta({ ref: "SessionSuperPlanInfo" })
export type SuperPlanSessionInfo = z.infer<typeof SuperPlanSessionInfo>

export const WorkflowInfo = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("plan"),
    }),
    z.object({
      kind: z.literal("lightloop"),
      taskDescription: z.string(),
      stopRequest: z
        .object({
          summary: z.string(),
          completed: z.array(z.string()).optional(),
          evidence: z.array(z.string()).optional(),
          remaining: z.array(z.string()).optional(),
          requestedAt: z.number(),
          requesterSessionID: z.string(),
          requesterMessageID: z.string(),
          reviewTaskID: z.string().optional(),
          reviewSessionID: z.string().optional(),
        })
        .optional(),
      review: z
        .object({
          attempts: z.number(),
          lastReason: z.string().optional(),
          lastReviewedAt: z.number().optional(),
        })
        .optional(),
    }),
    z.object({
      kind: z.literal("lattice"),
      runID: z.string(),
      mode: z.enum(["auto", "collaborative"]),
      firstBlueprintStarted: z.boolean().optional(),
    }),
  ])
  .meta({ ref: "SessionWorkflowInfo" })
export type WorkflowInfo = z.infer<typeof WorkflowInfo>

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

export const CompletionNotice = z
  .object({
    unread: z.boolean(),
    silent: z.boolean(),
  })
  .meta({ ref: "SessionCompletionNotice" })
export type CompletionNotice = z.infer<typeof CompletionNotice>

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
      forkedFrom: z
        .object({
          sessionID: Identifier.schema("session"),
          messageID: Identifier.schema("message").optional(),
          title: z.string().optional(),
        })
        .optional(),
      category: z.enum(["project", "home", "channel", "background"]).optional(),
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
      completionNotice: CompletionNotice.default(() => ({ unread: false, silent: false })),
      modelOverride: z
        .object({
          providerID: z.string(),
          modelID: z.string(),
        })
        .optional()
        .describe("Per-session model override set by /model command"),
      agentOverride: z.string().optional().describe("Per-session agent override set by session control"),
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
      history: HistoryInfo.optional(),
      cortex: CortexDelegationInfo.optional(),
      superplan: SuperPlanSessionInfo.optional(),
      working: WorkingInfo.optional(),
      workspace: Workspace.optional(),
      blueprint: z
        .object({
          loopID: z.string().optional(),
          loopRole: z.enum(["execution", "audit"]).optional(),
        })
        .optional(),
      workflow: WorkflowInfo.optional(),
    }),
  )
  .meta({
    ref: "Session",
  })

export type Info = z.infer<typeof Info>
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
