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
  // Task — what the agent does when triggered
  // ---------------------------------------------------------------------------

  export const SessionRef = z
    .object({
      sessionID: z.string(),
      hint: z.string().optional().describe("Brief description of what this session contains"),
    })
    .meta({ ref: "AgendaSessionRef" })
  export type SessionRef = z.infer<typeof SessionRef>

  export const SessionMode = z.enum(["ephemeral", "persistent"])
  export type SessionMode = z.infer<typeof SessionMode>

  export const ContextMode = z.enum(["full", "signal", "none"])
  export type ContextMode = z.infer<typeof ContextMode>

  export const Task = z
    .object({
      prompt: z.string().describe("Instruction for the agent"),
      agent: z.string().optional().describe("Agent to use, defaults to the configured default"),
      model: z
        .object({
          providerID: z.string(),
          modelID: z.string(),
        })
        .optional()
        .describe("Model override"),
      workScope: ScopeField.optional().describe("Execution scope. Defaults to global (home) if omitted"),
      sessionRefs: z
        .array(SessionRef)
        .optional()
        .describe("Sessions whose content may be relevant — injected as context references"),
      timeout: z.number().optional().describe("Execution timeout in milliseconds"),
      sessionMode: SessionMode.optional().describe(
        "'ephemeral' (default): create a new session per trigger. 'persistent': reuse the same session across triggers.",
      ),
      contextMode: ContextMode.optional().describe(
        "'full' (default): inject complete agenda context XML. 'signal': inject only the signal payload. 'none': send only the task prompt.",
      ),
    })
    .meta({ ref: "AgendaTask" })
  export type Task = z.infer<typeof Task>

  // ---------------------------------------------------------------------------
  // Delivery — where results are sent after execution
  // ---------------------------------------------------------------------------

  export const DeliveryAuto = z.object({
    target: z.literal("auto"),
  })

  export const DeliverySilent = z.object({
    target: z.literal("silent"),
  })

  export const DeliveryHome = z.object({
    target: z.literal("home"),
  })

  export const DeliverySession = z.object({
    target: z.literal("session"),
    sessionID: z.string(),
  })

  export const Delivery = z
    .discriminatedUnion("target", [DeliveryAuto, DeliverySilent, DeliveryHome, DeliverySession])
    .meta({ ref: "AgendaDelivery" })
  export type Delivery = z.infer<typeof Delivery>

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

      triggers: z
        .array(Trigger)
        .default([])
        .describe(
          "Activation conditions. Schedule items have time triggers; todo items may have none (manual activation) or non-time triggers.",
        ),

      task: Task.optional().describe("Execution configuration"),
      delivery: Delivery.optional().describe("Delivery configuration, defaults to { target: 'auto' }"),

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
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
      triggers: z.array(Trigger).optional(),
      task: Task.optional(),
      delivery: Delivery.optional(),
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
      task: Task.optional(),
      delivery: Delivery.optional(),
    })
    .meta({ ref: "AgendaPatchInput" })
  export type PatchInput = z.infer<typeof PatchInput>
}
