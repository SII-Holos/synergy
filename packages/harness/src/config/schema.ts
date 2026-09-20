import { StorageConfiguration } from "../storage/config"
import { Log } from "../util/log"
import z from "zod"
import { MAX_EXECUTION_CANCEL_GRACE_MS } from "@ericsanchezok/synergy-util/runtime-shutdown"
import { ModelsDev } from "../provider/models-schemas"
import { ProviderPricing } from "../provider/pricing"
import { ModelRole } from "../provider/model-role"
import { ConfigExtensions } from "./extensions"

export const SandboxConfig = z
  .object({
    enabled: z.boolean().optional().describe("Enable the sandbox runtime when available (default: true)"),
    fallbackPolicy: z
      .enum(["warn", "allow", "deny"])
      .optional()
      .describe("How to proceed when the requested sandbox runtime is unavailable (default: 'warn')"),
    backend: z
      .enum([
        "auto",
        "seatbelt-deny-default",
        "seatbelt-legacy-allow-default",
        "synergy-sandbox-linux",
        "bwrap-inline-debug",
        "windows-restricted-token",
        "windows-elevated",
      ])
      .optional()
      .describe(
        "Force a specific sandbox backend. 'auto' (default) selects the platform-native backend. " +
          "Valid: 'auto' (platform default), 'seatbelt-deny-default' (macOS deny-default SBPL), " +
          "'seatbelt-legacy-allow-default' (macOS allow-default SBPL), " +
          "'synergy-sandbox-linux' (Linux bundled bwrap), 'bwrap-inline-debug' (Linux in-tree bwrap debug), " +
          "'windows-restricted-token' (Windows MVP), 'windows-elevated' (Windows full, future).",
      ),
    network: z
      .object({
        mode: z
          .enum(["restricted", "proxy_only", "full"])
          .optional()
          .describe("Network access mode within the sandbox (default: 'restricted')"),
      })
      .strict()
      .optional()
      .describe("Network configuration for sandbox enforcement"),
    macos: z
      .object({
        denialLogger: z.boolean().optional().describe("Log sandbox denials via macOS Seatbelt (default: true)"),
      })
      .strict()
      .optional()
      .describe("macOS-specific sandbox settings"),
    linux: z
      .object({
        bundledBwrap: z
          .boolean()
          .optional()
          .describe("Use the bundled bwrap binary instead of system bwrap (default: true)"),
        landlockFallback: z
          .boolean()
          .optional()
          .describe("Fall back to Landlock LSM when bwrap is unavailable (default: true)"),
      })
      .strict()
      .optional()
      .describe("Linux-specific sandbox settings"),
    windows: z
      .object({
        level: z
          .enum(["disabled", "restricted-token", "elevated"])
          .optional()
          .describe("Windows sandbox level (default: 'restricted-token')"),
        helperPath: z.string().optional().describe("Path to the synergy-sandbox-windows.exe helper binary"),
        verifyHelperHash: z
          .boolean()
          .optional()
          .describe("Verify the helper binary SHA-256 hash before use (default: true)"),
        privateDesktop: z
          .boolean()
          .optional()
          .describe("Create a private desktop for the sandboxed process (default: true)"),
        conpty: z.boolean().optional().describe("Use ConPTY for pseudo-terminal support (default: true)"),
      })
      .strict()
      .optional()
      .describe("Windows-specific sandbox settings"),
  })
  .strict()
  .meta({ ref: "SandboxConfig" })
export type SandboxConfig = z.infer<typeof SandboxConfig>

export const ObservabilityConfig = z
  .object({
    modelSpans: z.boolean().optional().describe("Record AI SDK model spans (default: false)"),
    enabled: z
      .boolean()
      .optional()
      .describe("Enable local indexed observability events, spans, metrics, issues, and diagnostics (default: true)"),
    logMirror: z
      .boolean()
      .optional()
      .describe("Mirror debug/info records that opt in with `mirror: true` into indexed observability events"),
    retentionDays: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Days to retain optional observability mirror files (default: 7)"),
    maxBytes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum total local observability storage in bytes (default: 250MB)"),
    stalledToolMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Milliseconds without tool activity before emitting a stalled-tool observability event"),
    performance: z
      .object({
        enabled: z.boolean().optional().describe("Enable structured local performance metrics and traces"),
        samplingRate: z.number().min(0).max(1).optional().describe("Default performance metric sampling rate"),
        metricRetentionMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Milliseconds to retain raw performance metrics"),
        traceRetentionMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Milliseconds to retain performance spans and trace details"),
        resourceSampleIntervalMs: z.number().int().positive().optional().describe("Runtime resource sampling interval"),
        slowTraceThresholdMs: z.number().int().positive().optional().describe("Default slow trace issue threshold"),
        maxTraceEvents: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum related events returned for a trace detail"),
        maxTimelineBuckets: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum timeline buckets returned to the dashboard"),
        maxTraceListLimit: z.number().int().positive().optional().describe("Maximum trace list rows returned"),
        maxAttributeStringLength: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum redacted attribute string length"),
        dashboardRefreshMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Performance dashboard polling refresh interval"),
        sseHeartbeatMs: z.number().int().positive().optional().describe("Performance SSE heartbeat interval"),
        sseBufferSize: z.number().int().positive().optional().describe("Performance event stream replay buffer size"),
        perClientSseQueueSize: z.number().int().positive().optional().describe("Per-client performance SSE queue size"),
        redactAttributeKeys: z
          .array(z.string())
          .optional()
          .describe("Additional performance telemetry attribute keys to redact"),
        rateLimits: z.record(z.string(), z.number().int().positive()).optional(),
        storage: z
          .object({
            sqliteEnabled: z.boolean().optional(),
            jsonlMirrorEnabled: z
              .boolean()
              .optional()
              .describe("Enable optional JSONL mirror files for debugging exports"),
            maxSqliteBytes: z
              .number()
              .int()
              .positive()
              .optional()
              .describe("Maximum bytes for the local observability database (default: 250MB)"),
            retentionBytes: z
              .number()
              .int()
              .positive()
              .optional()
              .describe(
                "Byte budget for authoritative storage (default: 40GB). Budgeted pruning only runs while the database exceeds it, and the operative retention window is derived from it and the measured ingress rate, so this value decides how much evidence can actually be retained.",
              ),
            retentionMs: z
              .number()
              .int()
              .min(0)
              .optional()
              .describe(
                "Retain authoritative evidence for this long (default: 7 days, bounds 1 hour to 90 days; set 0 to disable). This is a promise the byte budget may shorten, never lengthen: when retentionBytes holds less than this window at the measured ingress rate, pruning uses the shorter budget-derived window and reports it, and a budget that cannot hold even one day raises an unreachable-budget issue without pruning.",
              ),
            walCheckpointIntervalMs: z.number().int().positive().optional(),
            requestDeadlineMs: z
              .number()
              .int()
              .positive()
              .optional()
              .describe(
                "Budget for one ordinary statement against authoritative storage (default: 30000 ms). Exceeding it retries rather than terminating: the worker's liveness probe reports occupancy separately, so one slow statement cannot restart the runtime.",
              ),
            probeTimeoutMs: z
              .number()
              .int()
              .positive()
              .optional()
              .describe(
                "Budget for one authoritative-storage liveness probe (default: 30000 ms). An unanswered probe marks the worker busy rather than dead, so this value decides how quickly degradation is noticed, not whether the runtime survives.",
              ),
            probeAttempts: z
              .number()
              .int()
              .positive()
              .optional()
              .describe(
                "Unanswered liveness probes in a row before the worker is reported as busy (default: 3). Only sustained silence past hardCeilingMs is terminal, so this value governs when the condition becomes visible.",
              ),
            hardCeilingMs: z
              .number()
              .int()
              .positive()
              .optional()
              .describe(
                "Sustained worker unresponsiveness after which authoritative storage is terminally wedged and the runtime escalates through its managed restart (default: 3600000 ms). Must exceed the longest legitimate statement, because three maintenance statements cannot be chunked or cancelled: SQLite has no partial index build, the physical integrity check is one engine call, and VACUUM rewrites every page. Measured on production-shaped fixtures the check alone took 17-33 s at 920,000 records and 140-280 s at 2,760,000 records, and it runs while a migration activates, so the projection to a much larger store is a range rather than a point. Raising this only delays declaring a real wedge, during which storage already fails new work fast and the runtime keeps serving, so it is the safe direction to err; lower it only if a shorter recovery time matters more than the risk of interrupting a migration.",
              ),
            chunkBudgetMs: z
              .number()
              .int()
              .positive()
              .optional()
              .describe(
                "Budget for reclaim, the only maintenance operation that can be split: it frees a bounded page count per call, so a fixed budget is enforceable (default: 30000 ms). CREATE INDEX, PRAGMA integrity_check and VACUUM cannot be chunked or cancelled, so they are bounded by hardCeilingMs instead and raising this value does not extend them. This value is clamped below hardCeilingMs with a fixed margin that raising it cannot consume, and requestDeadlineMs and probeTimeoutMs are clamped the same way, because the invariant only holds when every limit that can occupy the worker's loop leaves that margin.",
              ),
          })
          .strict()
          .optional(),
        thresholds: z.record(z.string(), z.number().positive()).optional(),
      })
      .strict()
      .optional()
      .describe("Structured local performance observability settings"),
  })
  .strict()
  .meta({ ref: "ObservabilityConfig" })
export type ObservabilityConfig = z.infer<typeof ObservabilityConfig>

export const PermissionAction = z.enum(["ask", "allow", "deny"]).meta({
  ref: "PermissionActionConfig",
})
export type PermissionAction = z.infer<typeof PermissionAction>

export const ControlProfileId = z.enum(["guarded", "autonomous", "full_access"]).meta({ ref: "ControlProfileId" })
export type ControlProfileId = z.infer<typeof ControlProfileId>

export const PermissionObject = z.record(z.string(), PermissionAction).meta({
  ref: "PermissionObjectConfig",
})
export type PermissionObject = z.infer<typeof PermissionObject>

export const PermissionRule = z.union([PermissionAction, PermissionObject]).meta({
  ref: "PermissionRuleConfig",
})
export type PermissionRule = z.infer<typeof PermissionRule>

// Capture original key order before zod reorders, then rebuild in original order
const permissionPreprocess = (val: unknown) => {
  if (typeof val === "object" && val !== null && !Array.isArray(val)) {
    return { __originalKeys: Object.keys(val), ...val }
  }
  return val
}

const permissionTransform = (x: unknown): Record<string, PermissionRule> => {
  if (typeof x === "string") return { "*": x as PermissionAction }
  const obj = x as { __originalKeys?: string[] } & Record<string, unknown>
  const { __originalKeys, ...rest } = obj
  if (!__originalKeys) return rest as Record<string, PermissionRule>
  const result: Record<string, PermissionRule> = {}
  for (const key of __originalKeys) {
    if (key in rest) result[key] = rest[key] as PermissionRule
  }
  return result
}

export const Permission = z
  .preprocess(
    permissionPreprocess,
    z
      .object({
        __originalKeys: z.string().array().optional(),
        read: PermissionRule.optional(),
        edit: PermissionRule.optional(),
        glob: PermissionRule.optional(),
        grep: PermissionRule.optional(),
        list: PermissionRule.optional(),
        bash: PermissionRule.optional(),
        task: PermissionRule.optional(),
        external_directory: PermissionRule.optional(),
        todowrite: PermissionAction.optional(),
        todoread: PermissionAction.optional(),
        dagwrite: PermissionAction.optional(),
        dagread: PermissionAction.optional(),
        question: PermissionAction.optional(),
        webfetch: PermissionAction.optional(),
        download: PermissionAction.optional(),
        lsp: PermissionRule.optional(),
        doom_loop: PermissionAction.optional(),
      })
      .catchall(PermissionRule)
      .or(PermissionAction),
  )
  .transform(permissionTransform)
  .meta({
    ref: "PermissionConfig",
  })
export type Permission = z.infer<typeof Permission>

export const Command = z.object({
  template: z.string(),
  description: z.string().optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
})
export type Command = z.infer<typeof Command>

export const Agent = z
  .object({
    model: z.string().optional(),
    modelRole: ModelRole.optional().describe("Model role to resolve for this agent when model is not set"),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    prompt: z.string().optional(),
    tools: z.record(z.string(), z.boolean()).optional().describe("@deprecated Use 'permission' field instead"),
    disable: z.boolean().optional(),
    description: z.string().optional().describe("Description of when to use the agent"),
    mode: z.enum(["subagent", "primary", "all"]).optional(),
    hidden: z
      .boolean()
      .optional()
      .describe("Hide this subagent from the @ autocomplete menu (default: false, only applies to mode: subagent)"),
    visibleTo: z
      .array(z.string())
      .optional()
      .describe("Agent or delegation group names allowed to delegate to this subagent"),
    delegationGroups: z
      .array(z.string())
      .optional()
      .describe("Additional delegation catalogs this agent may use when dispatching subagents"),
    deferredTools: z
      .array(z.string())
      .optional()
      .describe("Tool IDs folded behind expand_tools for this agent, such as task delegation and DAG planning tools"),
    options: z.record(z.string(), z.any()).optional(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "Invalid hex color format")
      .optional()
      .describe("Hex color code for the agent (e.g., #FF5733)"),
    steps: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum number of agentic iterations before forcing text-only response"),
    maxSteps: z.number().int().positive().optional().describe("@deprecated Use 'steps' field instead."),
    permission: Permission.optional(),
    controlProfile: ControlProfileId.optional().describe("Control profile for this agent's enforcement gate"),
    defaultVariant: z
      .string()
      .optional()
      .describe(
        "Default variant to apply when this agent runs. Overrides the role-level variant. Per-request variant overrides this.",
      ),
  })
  .catchall(z.any())
  .transform((agent, ctx) => {
    const knownKeys = new Set([
      "name",
      "model",
      "modelRole",
      "prompt",
      "description",
      "temperature",
      "top_p",
      "mode",
      "hidden",
      "visibleTo",
      "delegationGroups",
      "color",
      "deferredTools",
      "steps",
      "maxSteps",
      "options",
      "permission",
      "disable",
      "tools",
      "controlProfile",
      "defaultVariant",
    ])

    // Extract unknown properties into options
    const options: Record<string, unknown> = { ...agent.options }
    for (const [key, value] of Object.entries(agent)) {
      if (!knownKeys.has(key)) options[key] = value
    }

    // Convert legacy tools config to permissions
    const permission: Permission = {}
    for (const [tool, enabled] of Object.entries(agent.tools ?? {})) {
      const action = enabled ? "allow" : "deny"
      // write, edit, patch, multiedit all map to edit permission
      if (tool === "write" || tool === "edit" || tool === "patch" || tool === "multiedit") {
        permission.edit = action
      } else {
        permission[tool] = action
      }
    }
    Object.assign(permission, agent.permission)

    // Convert legacy maxSteps to steps
    const steps = agent.steps ?? agent.maxSteps

    return { ...agent, options, permission, steps } as typeof agent & {
      options?: Record<string, unknown>
      permission?: Permission
      steps?: number
    }
  })
  .meta({
    ref: "AgentConfig",
  })
export type Agent = z.infer<typeof Agent>

export const Server = z
  .object({
    port: z.number().int().positive().optional().describe("Port to listen on"),
    hostname: z.string().optional().describe("Hostname to listen on"),
    mdns: z.boolean().optional().describe("Enable mDNS service discovery"),
    cors: z.array(z.string()).optional().describe("Additional origins allowed for CORS and Browser viewer WebSockets"),
  })
  .strict()
  .meta({
    ref: "ServerConfig",
  })

export const CategoryConfig = z
  .object({
    model: z.string().optional().describe("Model to use for this category (e.g., 'sii-openai/GPT-5.2')"),
    temperature: z.number().optional().describe("Temperature override for this category"),
    promptAppend: z.string().optional().describe("Additional prompt context to inject for this category"),
    description: z.string().optional().describe("Description of when to use this category"),
  })
  .strict()
  .meta({
    ref: "CategoryConfig",
  })
export type CategoryConfig = z.infer<typeof CategoryConfig>

export const AttachmentConfig = z
  .object({
    maxFiles: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum number of prompt attachments per batch (default: 20)"),
    maxFileBytes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum prompt attachment size in bytes per file (default: 209715200 = 200 MiB)"),
    maxTotalBytes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum aggregate prompt attachment size in bytes per batch (default: 2147483648 = 2 GiB)"),
  })
  .strict()
  .meta({
    ref: "AttachmentConfig",
  })
export type AttachmentConfig = z.infer<typeof AttachmentConfig>

export const Provider = ModelsDev.Provider.partial()
  .extend({
    profile: z
      .string()
      .min(1)
      .optional()
      .describe("Canonical provider profile whose runtime behavior this account connection uses"),
    modelsDevProviderID: z
      .string()
      .min(1)
      .optional()
      .describe("Models.dev provider id to use as this provider connection's model catalog source"),
    whitelist: z.array(z.string()).optional(),
    blacklist: z.array(z.string()).optional(),
    models: z
      .record(
        z.string(),
        ModelsDev.Model.partial().extend({
          cost: ProviderPricing.ModelConfigCost.optional(),
          variants: z
            .record(
              z.string(),
              z
                .object({
                  disabled: z.boolean().optional().describe("Disable this variant for the model"),
                })
                .catchall(z.any()),
            )
            .optional()
            .describe("Variant-specific configuration"),
        }),
      )
      .optional(),
    options: z
      .object({
        apiKey: z.string().optional(),
        baseURL: z.string().optional(),
        enterpriseUrl: z.string().optional().describe("GitHub Enterprise URL for copilot authentication"),
        setCacheKey: z.boolean().optional().describe("Enable promptCacheKey for this provider (default false)"),
        mergeSystemMessages: z
          .boolean()
          .optional()
          .describe(
            "Merge leading system messages into a single system message for strict OpenAI-compatible endpoints that reject multiple or non-leading system messages (e.g. vLLM Qwen chat templates). Default false.",
          ),
        timeout: z
          .union([
            z
              .number()
              .int()
              .positive()
              .describe("Idle timeout in milliseconds for requests to this provider. Set to false to disable timeout."),
            z.literal(false).describe("Disable timeout for this provider entirely."),
          ])
          .optional()
          .describe("Idle timeout in milliseconds for requests to this provider. Set to false to disable timeout."),
      })
      .catchall(z.any())
      .optional(),
  })
  .strict()
  .meta({
    ref: "ProviderConfig",
  })
export type Provider = z.infer<typeof Provider>

const CoreInfo = z
  .object({
    $schema: z.string().optional().describe("JSON schema reference for configuration validation"),
    logLevel: Log.Level.optional().describe("Log level"),
    storage: StorageConfiguration.optional().describe(
      "Global authoritative storage; backend changes require an explicit storage migration",
    ),
    server: Server.optional().describe("Server configuration for synergy serve and web commands"),
    attachment: AttachmentConfig.optional().describe("Prompt attachment upload limits (count and byte sizes)"),
    command: z.record(z.string(), Command).optional().describe("Command configuration"),
    timeout: z
      .object({
        invoke_sec: z
          .number()
          .positive()
          .optional()
          .describe("Max wall-clock seconds for one assistant step (default: 21600 = 6h)"),
        provider: z
          .object({
            ttfb_sec: z
              .number()
              .positive()
              .optional()
              .describe(
                "Max seconds to wait for first byte (TTFB) from provider. " +
                  "Accommodates reasoning/thinking models (e.g. o1-pro, deepseek-r1). " +
                  "Default: 3600 = 1h",
              ),
            idle_sec: z
              .union([z.number().min(0), z.literal(false)])
              .optional()
              .describe(
                "Idle timeout in seconds (0/false = disable, default: 900 = 15min). Resets on each data chunk.",
              ),
            wall_sec: z
              .number()
              .min(0)
              .optional()
              .describe(
                "Hard wall-clock timeout per HTTP request in seconds " +
                  "(0 = disabled, default: 0). CAUTION: conflicts with streaming — " +
                  "will interrupt normal token output. Only enable if you need a " +
                  "hard cap beyond idle+TTFB",
              ),
          })
          .optional(),
        tool: z
          .object({
            default_sec: z
              .number()
              .positive()
              .optional()
              .describe("Default timeout per tool execution in seconds (default: 7200 = 2h)"),
            overrides: z
              .record(z.string(), z.number().positive())
              .optional()
              .describe("Per-tool timeout overrides by tool name, e.g. { bash: 600, webfetch: 120 }"),
          })
          .optional(),
        permission: z
          .object({
            ask_sec: z
              .number()
              .positive()
              .optional()
              .describe("Max seconds to wait for permission approval before auto-denying (default: 3600 = 1h)"),
          })
          .optional(),
      })
      .optional()
      .describe("Timeout configuration for assistant steps, provider requests, tool execution, and permission prompts"),
    cortex: z
      .object({
        primaryOnlyTools: z.array(z.string()).optional().describe("Tools excluded from delegated agents"),
        maxConcurrentTasks: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of Cortex subagent tasks that may run concurrently (default: 8)"),
      })
      .strict()
      .optional()
      .describe("Cortex task scheduling configuration"),
    execution: z
      .object({
        continueOnDeny: z.boolean().optional().describe("Continue the loop after a denied tool call (default: false)"),
        messageCache: z.object({ enabled: z.boolean().optional(), verify: z.boolean().optional() }).strict().optional(),
        lspIdleReap: z.boolean().optional().describe("Reap idle language servers (default: true)"),
        agentWorkers: z
          .number()
          .int()
          .positive()
          .max(64)
          .nullable()
          .optional()
          .describe(
            "Maximum number of isolated Agent workers (default: derived from the effective memory limit, capped by available CPUs and 64, never below agentWorkerMinIdle). Pass null to clear the explicit ceiling and derive it from the machine.",
          ),
        agentWorkerMinIdle: z
          .number()
          .int()
          .nonnegative()
          .max(64)
          .optional()
          .describe(
            "Minimum number of idle Agent workers kept warm (default: 1 on resident servers, 0 for one-shot runs; cannot exceed agentWorkers)",
          ),
        agentWorkerIdleTimeoutMs: z
          .number()
          .int()
          .min(1_000)
          .max(3_600_000)
          .optional()
          .describe("Time an excess idle Agent worker remains warm before retirement (default: 60000)"),
        agentQueueMax: z
          .number()
          .int()
          .nonnegative()
          .max(32_768)
          .optional()
          .describe("Maximum queued Agent turns waiting for a worker (default: 256)"),
        agentQueueMaxMb: z
          .number()
          .int()
          .positive()
          .max(4_096)
          .optional()
          .describe("Maximum aggregate queued Agent-turn payload size in MiB (default: 256)"),
        agentWorkerMaxTurns: z
          .number()
          .int()
          .positive()
          .max(10_000)
          .optional()
          .describe("Turns completed before an Agent worker is recycled (default: 64)"),
        agentWorkerMaxRssMb: z
          .number()
          .int()
          .positive()
          .max(131_072)
          .optional()
          .describe(
            "Hard RSS limit in MiB for an Agent worker; the soft recycle watermark is half this value (default: 3072)",
          ),
        agentWorkerMaxHeapMb: z
          .number()
          .int()
          .positive()
          .max(131_072)
          .optional()
          .describe(
            "Hard heap-used limit in MiB for an Agent worker; the soft recycle watermark is half this value (default: 2048)",
          ),
        agentWorkerIdleBaselineRecycle: z
          .boolean()
          .optional()
          .describe(
            "Recycle idle Agent workers after post-GC memory grows beyond their warm baseline (default: Linux only)",
          ),
        agentWorkerIdleBaselineRssGrowthMb: z
          .number()
          .int()
          .positive()
          .max(131_072)
          .optional()
          .describe("Allowed post-GC RSS growth above an Agent worker's warm idle baseline in MiB (default: 256)"),
        agentWorkerIdleBaselineExternalGrowthMb: z
          .number()
          .int()
          .positive()
          .max(131_072)
          .optional()
          .describe(
            "Allowed post-GC external-memory growth above an Agent worker's warm idle baseline in MiB (default: 128)",
          ),
        agentCancelGraceMs: z
          .number()
          .int()
          .nonnegative()
          .max(MAX_EXECUTION_CANCEL_GRACE_MS)
          .optional()
          .describe("Grace period before terminating an Agent worker that ignores cancellation (default: 5000)"),
        agentHeartbeatTimeoutMs: z
          .number()
          .int()
          .min(30_000)
          .max(300_000)
          .optional()
          .describe("Maximum time without an Agent worker heartbeat before forced replacement (default: 45000)"),
        policyWorkers: z
          .number()
          .int()
          .positive()
          .max(16)
          .optional()
          .describe("Number of isolated Policy workers (default: min(2, available CPUs - 1), at least 1)"),
        policyQueueMax: z
          .number()
          .int()
          .nonnegative()
          .max(32_768)
          .optional()
          .describe("Maximum queued Policy classifications waiting for a worker (default: 256)"),
        policyQueueMaxMb: z
          .number()
          .int()
          .positive()
          .max(1_024)
          .optional()
          .describe("Maximum aggregate queued Policy-classification payload size in MiB (default: 64)"),
        policyTimeoutMs: z
          .number()
          .int()
          .min(50)
          .max(10_000)
          .optional()
          .describe("Maximum total time for a Policy classification before conservative fallback (default: 1000)"),
        policyWorkerMaxRequests: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Classifications completed before a Policy worker is recycled (default: 512)"),
        policyWorkerMaxRssMb: z
          .number()
          .int()
          .positive()
          .max(16_384)
          .optional()
          .describe("RSS threshold in MiB for terminating or recycling a Policy worker (default: 512)"),
        policyWorkerMaxHeapMb: z
          .number()
          .int()
          .positive()
          .max(16_384)
          .optional()
          .describe("Heap-used threshold in MiB for terminating or recycling a Policy worker (default: 256)"),
        policyCancelGraceMs: z
          .number()
          .int()
          .nonnegative()
          .max(10_000)
          .optional()
          .describe("Shutdown grace period before terminating a Policy worker (default: 25)"),
        policyHeartbeatTimeoutMs: z
          .number()
          .int()
          .min(10_000)
          .max(120_000)
          .optional()
          .describe("Maximum time without a Policy worker heartbeat before forced replacement (default: 15000)"),
        toolConcurrency: z
          .number()
          .int()
          .positive()
          .max(512)
          .optional()
          .describe("Maximum process-wide concurrent ToolTasks (default: twice available CPUs, bounded to 4-32)"),
        toolQueueMax: z
          .number()
          .int()
          .nonnegative()
          .max(65_536)
          .optional()
          .describe("Maximum queued ToolTasks waiting for execution capacity (default: 32 per tool slot)"),
        toolQueueMaxMb: z
          .number()
          .int()
          .positive()
          .max(4_096)
          .optional()
          .describe("Maximum aggregate queued ToolTask input size in MiB (default: 128)"),
        toolCancelGraceMs: z
          .number()
          .int()
          .nonnegative()
          .max(MAX_EXECUTION_CANCEL_GRACE_MS)
          .optional()
          .describe("Grace period for active ToolTasks during runtime shutdown (default: 3000)"),
        toolExecutorConcurrency: z
          .partialRecord(
            z.enum(["local_process", "file", "plugin", "mcp", "browser", "link", "control_plane"]),
            z.number().int().positive().max(512),
          )
          .optional()
          .describe("Optional concurrency limits for each Tool Executor class"),
      })
      .strict()
      .optional()
      .describe("Process isolation, worker recycling, and bounded execution scheduling"),
    watcher: z
      .object({
        ignore: z.array(z.string()).optional(),
      })
      .optional(),
    snapshot: z.boolean().optional(),
    disabled_providers: z
      .array(z.string())
      .optional()
      .describe(
        "Disable providers that are loaded automatically. Empty arrays are ignored in each config layer, preserving lower-priority filters",
      ),
    enabled_providers: z
      .array(z.string())
      .optional()
      .describe(
        "When non-empty, ONLY these providers will be enabled. Empty arrays are ignored in each config layer, preserving lower-priority filters",
      ),
    model: z
      .string()
      .nullable()
      .describe("Default model in the format of provider/model, eg anthropic/claude-sonnet-4-5. null clears the role")
      .optional(),
    nano_model: z
      .string()
      .nullable()
      .describe(
        "Cheapest model for trivial extraction tasks like title generation, in the format of provider/model. Falls back to mini_model → mid_model → model. null clears the role's model",
      )
      .optional(),
    mini_model: z
      .string()
      .nullable()
      .describe(
        "Lightweight model for simple tasks like intent extraction, in the format of provider/model. Falls back to mid_model → model. null clears the role's model",
      )
      .optional(),
    mid_model: z
      .string()
      .nullable()
      .describe(
        "Mid-tier model for internal agents that need moderate reasoning (script extraction, reward evaluation, code exploration), in the format of provider/model. Falls back to the default model. null clears the role's model",
      )
      .optional(),
    thinking_model: z
      .string()
      .nullable()
      .describe(
        "Deep thinking model for complex reasoning and architecture tasks, in the format of provider/model. Falls back to the default model if not set. null clears the role's model",
      )
      .optional(),
    long_context_model: z
      .string()
      .nullable()
      .describe(
        "Model with extra-large context window for processing very long inputs, in the format of provider/model. Falls back to the default model if not set. null clears the role's model",
      )
      .optional(),
    creative_model: z
      .string()
      .nullable()
      .describe(
        "Model for creative and visual tasks (UI design, writing, artistry), in the format of provider/model. Falls back to the default model if not set. null clears the role's model",
      )
      .optional(),
    vision_model: z
      .string()
      .nullable()
      .describe(
        "Model for separate image analysis via the look_at tool, in the format of provider/model. If not set, look_at is disabled. Direct current-model image context uses view_image based on the active model capability. null clears the role's model",
      )
      .optional(),
    role_variant: z
      .record(z.string(), z.string().nullable())
      .optional()
      .describe(
        "Default variant (e.g. low, medium, high, xhigh) applied per model role. Requires the resolved model to support the named variant. A null value clears the role's variant",
      ),
    default_agent: z
      .string()
      .optional()
      .describe(
        "Default agent to use when none is specified. Must be a primary agent. Falls back to 'synergy' if not set or if the specified agent is invalid.",
      ),
    username: z.string().optional().describe("Custom username to display in conversations instead of system username"),
    agent: z
      .object({
        // primary
        synergy: Agent.optional(),
        "synergy-max": Agent.optional(),
        "synergy-flash": Agent.optional(),
        // classic subagents
        developer: Agent.optional(),
        // subagent
        general: Agent.optional(),
        explore: Agent.optional(),
        // specialized
        title: Agent.optional(),
        summary: Agent.optional(),
        compaction: Agent.optional(),
      })
      .catchall(Agent)
      .optional()
      .describe("Agent configuration"),
    provider: z.record(z.string(), Provider).optional().describe("Custom provider configurations and model overrides"),
    sandbox: SandboxConfig.optional().describe("Sandbox configuration for workspace boundary enforcement"),
    observability: ObservabilityConfig.optional().describe("Local logs, indexed telemetry, and diagnostics settings"),
    controlProfile: ControlProfileId.optional().describe("Default control profile applied to all agents"),
    nonInteractiveControlProfile: z
      .enum(["autonomous", "full_access"])
      .optional()
      .describe(
        "Control profile for sessions created by non-interactive sources (Channels and Agenda) that have no explicit profile of their own. Default: autonomous. Changes apply to sessions created after the change; an existing bound Channel session keeps the profile it was created with.",
      ),
    fullAccessAcknowledged: z
      .boolean()
      .optional()
      .describe(
        "Records that the human accepted the risk of running with Full Access. Set by the confirmation dialog when Full Access is enabled from the UI; it is an awareness record, not a security boundary.",
      ),
    instructions: z.array(z.string()).optional().describe("Additional instruction files or patterns to include"),
    project_doc_fallback_filenames: z
      .array(z.string())
      .optional()
      .describe("Ordered fallback instruction filenames to try when AGENTS.md is missing in a directory"),
    project_doc_max_bytes: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Maximum bytes to include from each automatically discovered instruction file (default: 32768; 0 disables automatic discovery)",
      ),
    permission: Permission.optional(),
    smartAllow: z
      .boolean()
      .optional()
      .describe(
        "Use the SmartAllow internal agent to auto-allow high-confidence safe asks in guarded mode and eligible false-positive denies in autonomous mode using metadata or redacted evidence only; full_access does not need SmartAllow",
      ),
    tools: z.record(z.string(), z.boolean()).optional(),
    question: z
      .object({
        timeout: z
          .number()
          .min(0)
          .optional()
          .describe("Seconds before unanswered questions auto-expire (0 = no timeout, default 3600 = 1h)"),
      })
      .optional(),
    compaction: z
      .object({
        auto: z.boolean().optional().describe("Enable automatic compaction when context is full (default: true)"),
        prune: z.boolean().optional().describe("Enable pruning of old tool outputs (default: true)"),
        overflowThreshold: z
          .number()
          .min(0.5)
          .max(1)
          .optional()
          .describe("Fraction of usable context that triggers auto-compaction (default: 0.85)"),
        maxHistoryImages: z
          .number()
          .int()
          .optional()
          .describe(
            "Maximum number of historical images to send as base64 per request (older images replaced with text placeholders). Default: 8.",
          ),
        codexRemote: z
          .boolean()
          .optional()
          .describe(
            "Enable Codex Remote Compaction V2 for openai-codex sessions: request an opaque server-side compaction artifact alongside the local text summary and replay it on later same-model turns (default: false).",
          ),
      })
      .optional(),
    prompt: z
      .object({
        coauthorReminder: z
          .boolean()
          .optional()
          .describe("Include the git coauthor reminder in agent prompts (default: true)"),
      })
      .strict()
      .optional(),
    category: z
      .record(z.string(), CategoryConfig)
      .optional()
      .describe("Custom category configurations for background tasks. Categories define model and prompt presets."),
  })
  .strict()
  .meta({
    ref: "Config",
  })

export interface ConfigExtensionShape {}
type ComposedShape = {
  [K in keyof (typeof CoreInfo.shape & ConfigExtensionShape)]: (typeof CoreInfo.shape & ConfigExtensionShape)[K]
}
export const Info = ConfigExtensions.schema(CoreInfo) as z.ZodObject<ComposedShape>
export type Info = z.output<typeof Info>
