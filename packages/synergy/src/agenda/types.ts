import z from "zod"
import type { Scope } from "../scope/types"
import { opaque } from "../util/schema"
import { SessionEndpoint } from "../session/endpoint"

export namespace AgendaTypes {
  // ---------------------------------------------------------------------------
  // Item status
  // ---------------------------------------------------------------------------

  export const ItemStatus = z.enum(["pending", "active", "paused", "done", "cancelled"])
  export type ItemStatus = z.infer<typeof ItemStatus>

  // ---------------------------------------------------------------------------
  // Triggers
  // ---------------------------------------------------------------------------

  export const TriggerAt = z
    .object({
      type: z.literal("at"),
      at: z.number().describe("Unix timestamp (ms) for one-shot execution"),
    })
    .meta({ ref: "AgendaTriggerAt" })

  export const TriggerCron = z
    .object({
      type: z.literal("cron"),
      expr: z.string().describe("Cron expression, e.g. '0 9 * * *'"),
      tz: z.string().optional().describe("IANA timezone, e.g. 'Asia/Shanghai'"),
    })
    .meta({ ref: "AgendaTriggerCron" })

  export const TriggerEvery = z
    .object({
      type: z.literal("every"),
      interval: z.string().describe("Human duration, e.g. '30m', '2h', '1d'"),
      anchor: z.number().optional().describe("Unix timestamp (ms) to anchor the first tick"),
    })
    .meta({ ref: "AgendaTriggerEvery" })

  export const TriggerDelay = z
    .object({
      type: z.literal("delay"),
      delay: z.string().describe("Relative delay from creation, e.g. '30m', '2h'"),
    })
    .meta({ ref: "AgendaTriggerDelay" })

  export const TriggerWatch = z
    .object({
      type: z.literal("watch"),
      watch: z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("poll"),
          command: z.string().describe("Shell command to execute periodically"),
          interval: z.string().optional().describe("Poll interval, e.g. '5m'. Default: '1m'"),
          trigger: z
            .enum(["change", "match"])
            .default("change")
            .describe("'change': fire when output differs from previous; 'match': fire when output matches pattern"),
          match: z.string().optional().describe("Regex pattern, required when trigger is 'match'"),
        }),
        z.object({
          kind: z.literal("file"),
          glob: z.string().describe("File glob pattern to watch for changes, e.g. 'src/**/*.ts'"),
          event: z
            .enum(["add", "change", "unlink"])
            .optional()
            .describe("Specific file event to match. If omitted, triggers on any event"),
          debounce: z
            .string()
            .optional()
            .describe("Debounce window before firing, e.g. '500ms', '2s'. Default: '500ms'"),
        }),
        z.object({
          kind: z.literal("tool"),
          tool: z.string().describe("Synergy tool name to call, e.g. 'inspire_jobs'"),
          args: z.record(z.string(), z.unknown()).optional().describe("Arguments to pass to the tool"),
          interval: z.string().optional().describe("Poll interval, e.g. '5m'. Default: '5m'"),
          trigger: z
            .enum(["change", "match"])
            .default("change")
            .describe("'change': fire when tool output differs; 'match': fire when output matches pattern"),
          match: z.string().optional().describe("Regex pattern, required when trigger is 'match'"),
        }),
      ]),
    })
    .meta({ ref: "AgendaTriggerWatch" })

  export const TriggerWebhook = z
    .object({
      type: z.literal("webhook"),
      token: z.string().optional().describe("Auto-generated secret token for the webhook URL"),
    })
    .meta({ ref: "AgendaTriggerWebhook" })

  export const Trigger = z
    .discriminatedUnion("type", [TriggerAt, TriggerCron, TriggerEvery, TriggerDelay, TriggerWatch, TriggerWebhook])
    .meta({ ref: "AgendaTrigger" })
  export type Trigger = z.infer<typeof Trigger>

  // ---------------------------------------------------------------------------
  // Session mode — inferred internally, not user-facing
  // ---------------------------------------------------------------------------

  export type SessionMode = "ephemeral" | "persistent"

  export function inferSessionMode(triggers: Trigger[]): SessionMode {
    const hasRecurring = triggers.some((t) => t.type === "cron" || t.type === "every" || t.type === "watch")
    return hasRecurring ? "persistent" : "ephemeral"
  }

  export type ContextMode = "full" | "signal"

  export function inferContextMode(sessionMode: SessionMode): ContextMode {
    return sessionMode === "persistent" ? "signal" : "full"
  }

  // ---------------------------------------------------------------------------
  // Origin — creation context
  // ---------------------------------------------------------------------------

  const ScopeField = opaque<Scope>(
    z.object({
      id: z.string(),
      type: z.string().optional(),
      directory: z.string().optional(),
      worktree: z.string().optional(),
    }),
    { ref: "AgendaScope" },
  )

  export const Origin = z
    .object({
      scope: ScopeField.describe("Scope where the item was created"),
      sessionID: z.string().optional().describe("Session where the item was created"),
      endpoint: SessionEndpoint.Info.optional().describe("Endpoint context if created from a session endpoint"),
    })
    .meta({ ref: "AgendaOrigin" })
  export type Origin = z.infer<typeof Origin>

  // ---------------------------------------------------------------------------
  // Session reference
  // ---------------------------------------------------------------------------

  export const SessionRef = z
    .object({
      sessionID: z.string(),
      hint: z.string().optional().describe("Brief description of what this session contains"),
    })
    .meta({ ref: "AgendaSessionRef" })
  export type SessionRef = z.infer<typeof SessionRef>

  // ---------------------------------------------------------------------------
  // Item state — mutable runtime state tracked across runs
  // ---------------------------------------------------------------------------

  export const RunStatus = z.enum(["ok", "error", "skipped"])
  export type RunStatus = z.infer<typeof RunStatus>

  export const ItemState = z
    .object({
      nextRunAt: z.number().optional().describe("Next scheduled execution time (ms)"),
      lastRunAt: z.number().optional().describe("Last execution start time (ms)"),
      lastRunStatus: RunStatus.optional(),
      lastRunError: z.string().optional(),
      lastRunDuration: z.number().optional().describe("Last execution duration (ms)"),
      lastRunSessionID: z.string().optional().describe("Session ID of the most recent execution"),
      persistentSessionID: z.string().optional().describe("Reused session ID for persistent session mode"),
      consecutiveErrors: z.number().default(0).describe("Consecutive error count, reset on success"),
      runCount: z.number().default(0).describe("Total number of executions"),
    })
    .meta({ ref: "AgendaItemState" })
  export type ItemState = z.infer<typeof ItemState>

  // ---------------------------------------------------------------------------
  // The complete agenda item
  // ---------------------------------------------------------------------------

  export const Item = z
    .object({
      id: z.string().describe("Unique item identifier"),
      status: ItemStatus,
      title: z.string(),
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
      global: z.boolean().default(false).describe("If true, item is visible from all scopes"),

      triggers: z.array(Trigger).default([]).describe("Activation conditions"),

      prompt: z.string().describe("Instruction for the agent when triggered"),

      // Advanced execution options
      agent: z.string().optional().describe("Agent to use, defaults to configured default"),
      model: z.object({ providerID: z.string(), modelID: z.string() }).optional().describe("Model override"),
      sessionRefs: z
        .array(SessionRef)
        .optional()
        .describe("Sessions whose content may be relevant — injected as context references"),
      timeout: z.number().optional().describe("Execution timeout in milliseconds"),

      // Notification behavior
      wake: z.boolean().default(true).describe("Whether to wake the origin session's agent on completion"),
      silent: z.boolean().default(false).describe("Whether to suppress result delivery entirely"),

      origin: Origin.describe("Context captured at creation time"),
      createdBy: z.enum(["user", "agent"]),

      state: ItemState.default({
        consecutiveErrors: 0,
        runCount: 0,
      }),

      time: z.object({
        created: z.number(),
        updated: z.number(),
      }),
    })
    .meta({ ref: "AgendaItem" })
  export type Item = z.infer<typeof Item>

  // ---------------------------------------------------------------------------
  // Run log — execution history entry
  // ---------------------------------------------------------------------------

  export const RunLog = z
    .object({
      id: z.string().describe("Run identifier"),
      itemID: z.string(),
      status: RunStatus,
      trigger: z
        .object({
          type: z.string().describe("What triggered this run, e.g. 'cron', 'watch', 'manual'"),
          source: z.string().optional().describe("Trigger source identifier"),
        })
        .describe("What caused this execution"),
      sessionID: z.string().optional(),
      error: z.string().optional(),
      duration: z.number().optional().describe("Execution duration (ms)"),
      time: z.object({
        started: z.number(),
        completed: z.number().optional(),
      }),
    })
    .meta({ ref: "AgendaRunLog" })
  export type RunLog = z.infer<typeof RunLog>

  export const ActivityAgenda = z
    .object({
      id: z.string(),
      scopeID: z.string().describe("Scope that owns the agenda item"),
      title: z.string(),
      description: z.string().optional(),
      status: ItemStatus,
      tags: z.array(z.string()).optional(),
      global: z.boolean(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
      }),
    })
    .meta({ ref: "AgendaActivityAgenda" })
  export type ActivityAgenda = z.infer<typeof ActivityAgenda>

  export const ActivitySession = z
    .object({
      id: z.string(),
      scopeID: z.string().describe("Scope that owns the session"),
      title: z.string(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
        archived: z.number().optional(),
      }),
    })
    .meta({ ref: "AgendaActivitySession" })
  export type ActivitySession = z.infer<typeof ActivitySession>

  export const ActivityEntry = z
    .object({
      run: RunLog,
      agenda: ActivityAgenda,
      session: ActivitySession.optional(),
    })
    .meta({ ref: "AgendaActivityEntry" })
  export type ActivityEntry = z.infer<typeof ActivityEntry>

  export const ActivityPage = z
    .object({
      items: z.array(ActivityEntry),
      total: z.number(),
      limit: z.number(),
      offset: z.number(),
      hasMore: z.boolean(),
    })
    .meta({ ref: "AgendaActivityPage" })
  export type ActivityPage = z.infer<typeof ActivityPage>

  // ---------------------------------------------------------------------------
  // Fired signal — runtime representation of a trigger activation
  // ---------------------------------------------------------------------------

  export const FiredSignal = z
    .object({
      type: z.string().describe("Trigger type that fired, e.g. 'cron', 'watch', 'manual'"),
      source: z.string().describe("Source identifier, e.g. item ID or external source name"),
      payload: z.record(z.string(), z.unknown()).optional().describe("Data carried by the signal"),
      timestamp: z.number(),
    })
    .meta({ ref: "AgendaFiredSignal" })
  export type FiredSignal = z.infer<typeof FiredSignal>

  // ---------------------------------------------------------------------------
  // Create / Patch — input types for mutations
  // ---------------------------------------------------------------------------

  export const CreateInput = z
    .object({
      title: z.string(),
      prompt: z.string(),
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
      triggers: z.array(Trigger).optional(),
      global: z.boolean().optional(),
      wake: z.boolean().optional(),
      silent: z.boolean().optional(),
      agent: z.string().optional(),
      model: z.object({ providerID: z.string(), modelID: z.string() }).optional(),
      sessionRefs: z.array(SessionRef).optional(),
      timeout: z.number().optional(),
      createdBy: z.enum(["user", "agent"]).default("user"),
      sessionID: z.string().optional().describe("Session where the item was created"),
      endpoint: SessionEndpoint.Info.optional().describe("Endpoint context if created from a session endpoint"),
    })
    .meta({ ref: "AgendaCreateInput" })
  export type CreateInput = z.infer<typeof CreateInput>

  export const PatchInput = z
    .object({
      title: z.string().optional(),
      description: z.string().optional(),
      status: ItemStatus.optional(),
      tags: z.array(z.string()).optional(),
      triggers: z.array(Trigger).optional(),
      prompt: z.string().optional(),
      global: z.boolean().optional(),
      wake: z.boolean().optional(),
      silent: z.boolean().optional(),
      agent: z.string().optional(),
      sessionRefs: z.array(SessionRef).optional(),
    })
    .meta({ ref: "AgendaPatchInput" })
  export type PatchInput = z.infer<typeof PatchInput>
}
