import z from "zod"

const UiSurfaceId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
const JsAssetPath = z
  .string()
  .regex(/^[a-zA-Z0-9_/.-]+\.js$/)
  .max(256)

const ToolRendererDef = z
  .object({
    tool: z.string().min(1),
    exportName: z.string().optional().default("default"),
    priority: z.number().int().min(0).max(100).optional().default(0),
    fallback: z
      .object({
        icon: z.string().optional(),
        title: z.string().optional(),
        subtitleTemplate: z.string().optional(),
      })
      .optional(),
  })
  .strict()

const PartRendererDef = z
  .object({
    type: z.string().min(1),
    exportName: z.string().optional().default("default"),
    priority: z.number().int().min(0).max(100).optional().default(0),
  })
  .strict()

const NavigationDef = z
  .object({
    id: UiSurfaceId,
    label: z.string().min(1).max(64),
    icon: z.string().optional(),
    placement: z.enum(["sidebar", "page"]),
    exportName: z.string().optional().default("default"),
    order: z.number().int().optional().default(1000),
  })
  .strict()

const WorkbenchPanelDef = z
  .object({
    id: UiSurfaceId,
    label: z.string().min(1).max(64),
    icon: z.string().min(1),
    surface: z.enum(["side", "bottom"]),
    cardinality: z.enum(["exclusive", "singleton", "multi"]),
    requiresSession: z.boolean().optional(),
    exportName: z.string().optional().default("default"),
    order: z.number().int().optional().default(1000),
  })
  .strict()

const SettingsDef = z
  .object({
    id: UiSurfaceId,
    label: z.string().min(1).max(64),
    icon: z.string().optional(),
    group: z.string(),
    formSchema: z.record(z.string(), z.unknown()).optional(),
    exportName: z.string().optional().default("default"),
    order: z.number().int().optional().default(1000),
    visibility: z.enum(["standard", "developer"]).optional(),
  })
  .strict()

const MessageSlotName = z.string().regex(/^[a-z][a-z0-9.-]*(?:\.[a-z][a-z0-9.-]*)*$/)

const MessageSlotDef = z
  .object({
    id: UiSurfaceId,
    slot: MessageSlotName,
    exportName: z.string().optional().default("default"),
    order: z.number().int().optional().default(1000),
  })
  .strict()

const ComposerSlotDef = z
  .object({
    id: UiSurfaceId,
    slot: z.enum([
      "composer.above",
      "composer.below",
      "composer.toolbar.left",
      "composer.toolbar.right",
      "composer.add-menu",
      "composer.start-option",
    ]),
    exportName: z.string().optional().default("default"),
    order: z.number().int().optional().default(1000),
  })
  .strict()

const ThemeDef = z
  .object({
    id: z.string().min(1).max(64),
    label: z.string().min(1).max(64),
    path: z.string().min(1),
  })
  .strict()

const IconDef = z
  .object({
    name: z.string().min(1).max(128),
    path: z.string().min(1),
  })
  .strict()

const UICommandDef = z
  .object({
    id: UiSurfaceId,
    label: z.string().min(1).max(64),
    exportName: z.string().optional().default("default"),
    description: z.string().max(256).optional(),
    icon: z.string().optional(),
  })
  .strict()

const ToolExposureDef = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("resident"),
    })
    .strict(),
  z
    .object({
      mode: z.literal("group"),
      group: z.string().min(1),
      title: z.string().optional(),
      description: z.string().optional(),
      whenToExpand: z.string().optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("search"),
      title: z.string().optional(),
      keywords: z.array(z.string()).optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("internal"),
    })
    .strict(),
])

const TaskPermissionDef = z.union([
  z.boolean(),
  z
    .object({
      agents: z.array(z.string().min(1)).optional(),
      maxRuntimeMs: z.number().int().positive().optional(),
    })
    .strict(),
])

const ToolDisplayDef = z
  .object({
    kind: z.enum(["default", "media-generation"]).optional(),
    toolCard: z.enum(["visible", "hidden"]).optional(),
    media: z
      .object({
        type: z.enum(["image", "video", "audio"]),
        actionLabel: z.string().min(1).max(80).optional(),
        pendingTitle: z.string().min(1).max(120).optional(),
        pendingDescription: z.string().min(1).max(200).optional(),
        aspectRatio: z.enum(["1:1", "4:3", "16:9", "auto"]).optional(),
        size: z.enum(["small", "medium", "large"]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

const UIContribution = z
  .object({
    entry: JsAssetPath.optional(),
    minUIApiVersion: z
      .string()
      .regex(/^\d+\.\d+$/)
      .optional(),
    toolRenderers: z.array(ToolRendererDef).optional(),
    partRenderers: z.array(PartRendererDef).optional(),
    workbenchPanels: z.array(WorkbenchPanelDef).optional(),
    navigation: z.array(NavigationDef).optional(),
    settings: z.array(SettingsDef).optional(),
    messageSlots: z.array(MessageSlotDef).optional(),
    composerSlots: z.array(ComposerSlotDef).optional(),
    commands: z.array(UICommandDef).optional(),
    themes: z.array(ThemeDef).optional(),
    icons: z.array(IconDef).optional(),
  })
  .strict()
  .superRefine((ui, ctx) => {
    const requiresEntry =
      Boolean(ui.toolRenderers?.some((renderer) => !renderer.fallback)) ||
      Boolean(ui.partRenderers?.length) ||
      Boolean(ui.workbenchPanels?.length) ||
      Boolean(ui.navigation?.length) ||
      Boolean(ui.settings?.some((section) => !section.formSchema)) ||
      Boolean(ui.messageSlots?.length) ||
      Boolean(ui.composerSlots?.length) ||
      Boolean(ui.commands?.length)

    if (requiresEntry && !ui.entry) {
      ctx.addIssue({ code: "custom", path: ["entry"], message: "Solid UI surfaces require contributes.ui.entry" })
    }
    if (ui.entry && !ui.minUIApiVersion) {
      ctx.addIssue({
        code: "custom",
        path: ["minUIApiVersion"],
        message: "contributes.ui.minUIApiVersion is required when contributes.ui.entry is set",
      })
    }
  })
  .optional()

const PluginPermissionsSchema = z
  .object({
    /** Tool execution permissions */
    tools: z
      .object({
        shell: z.boolean().default(false),
        filesystem: z.preprocess(
          (val) => {
            if (val === true) return "write"
            if (val === false) return "none"
            return val
          },
          z.enum(["none", "read", "write"]).default("none"),
        ),
        network: z.boolean().default(false),
        mcp: z.enum(["none", "invoke", "spawn"]).default("none"),
        task: TaskPermissionDef.optional(),
      })
      .strict()
      .optional(),

    /** Data access */
    data: z
      .object({
        session: z.enum(["none", "metadata", "read"]).default("none"),
        workspace: z.enum(["none", "metadata", "read"]).default("none"),
        config: z.enum(["none", "plugin", "global"]).default("none"),
        secrets: z.enum(["none", "own"]).default("none"),
      })
      .strict()
      .optional(),

    /** Network access */
    network: z
      .object({
        connectDomains: z.array(z.string()).default([]),
        resourceDomains: z.array(z.string()).default([]),
        frameDomains: z.array(z.string()).default([]),
      })
      .strict()
      .optional(),

    /** UI surface permissions */
    ui: z.boolean().default(false).optional(),

    /** Hook permission declarations */
    hooks: z
      .object({
        events: z.enum(["none", "selected", "all"]).default("selected"),
        eventNames: z.array(z.string()).default([]),
        config: z.boolean().default(false),
        toolExecute: z.enum(["none", "own", "declared", "all"]).default("own"),
        permissionAsk: z.enum(["none", "own", "all"]).default("none"),
        promptTransform: z.boolean().default(false),
        compactionTransform: z.boolean().default(false),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional()
// PluginManifest: the declarative plugin descriptor (plugin.json)
export const PluginManifest = z
  .object({
    // Identity
    name: z.string().min(1).max(128),
    version: z.string().regex(/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$/),
    description: z.string().min(1).max(1024),
    author: z.string().optional(),
    homepage: z.string().url().optional(),
    repository: z.string().optional(),
    license: z.string().optional(),
    icon: z.string().optional(),
    keywords: z.array(z.string()).optional(),

    engines: z
      .object({
        synergy: z.string().optional(),
        bun: z.string().optional(),
      })
      .strict()
      .optional(),

    // Dependencies on other plugins
    dependencies: z.record(z.string(), z.string()).optional(),

    // Permission / trust declaration
    permissions: PluginPermissionsSchema,
    // Declarative contributions
    contributes: z
      .object({
        tools: z
          .array(
            z.object({
              id: z.string().optional(),
              name: z.string(),
              title: z.string().optional(),
              description: z.string(),
              icon: z.string().optional(),
              category: z.string().optional(),
              kind: z.string().optional(),
              exposure: ToolExposureDef.optional(),
              display: ToolDisplayDef.optional(),
              capabilities: z
                .object({
                  filesystem: z.enum(["none", "read", "write"]).optional(),
                  network: z.boolean().optional(),
                  shell: z.boolean().optional(),
                  session: z.enum(["none", "metadata", "read"]).optional(),
                  workspace: z.enum(["none", "metadata", "read"]).optional(),
                  config: z.enum(["none", "plugin", "global"]).optional(),
                })
                .strict()
                .optional(),
            }),
          )
          .optional(),

        skills: z
          .array(
            z.object({
              name: z.string(),
              description: z.string(),
              dir: z.string(),
            }),
          )
          .optional(),

        agents: z
          .array(
            z.object({
              name: z.string(),
              description: z.string(),
              mode: z.enum(["subagent", "primary", "all"]).default("subagent"),
              model: z.string().optional(),
              modelRole: z.enum(["vision", "nano", "mini", "mid", "thinking", "long", "creative"]).optional(),
              hidden: z.boolean().optional(),
              permission: z.record(z.string(), z.any()).optional(),
            }),
          )
          .optional(),

        mcp: z
          .object({
            defaults: z
              .object({
                startup: z.enum(["eager", "lazy", "manual"]).optional(),
                required: z.boolean().optional(),
                connectTimeout: z.number().optional(),
                listTimeout: z.number().optional(),
                callTimeout: z.number().optional(),
                retry: z
                  .object({
                    maxAttempts: z.number().int().positive().optional(),
                    backoffMs: z.number().int().positive().optional(),
                    backoffMultiplier: z.number().positive().optional(),
                    cooldownMs: z.number().int().nonnegative().optional(),
                  })
                  .optional(),
                idleShutdownMs: z.number().int().positive().optional(),
                toolFilter: z
                  .object({
                    include: z.array(z.string()).optional(),
                    exclude: z.array(z.string()).optional(),
                  })
                  .optional(),
                tools: z
                  .object({
                    approval: z.enum(["auto", "always", "per_session"]).optional(),
                    maxOutputBytes: z.number().int().positive().optional(),
                  })
                  .optional(),
                toolCache: z
                  .object({
                    mode: z.enum(["disabled", "session", "persistent"]).optional(),
                    ttlMs: z.number().int().positive().optional(),
                  })
                  .optional(),
              })
              .optional()
              .describe("Default lifecycle settings applied to all MCP servers contributed by this plugin"),
            locked: z
              .boolean()
              .optional()
              .describe("If true, the user cannot override this plugin's MCP server declarations"),
          })
          .catchall(
            z
              .object({
                type: z.literal("local"),
                command: z.array(z.string()),
                environment: z.record(z.string(), z.string()).optional(),
                description: z.string().optional(),
                timeout: z.number().optional(),
                startup: z.enum(["eager", "lazy", "manual"]).optional(),
                required: z.boolean().optional(),
                connectTimeout: z.number().optional(),
                listTimeout: z.number().optional(),
                callTimeout: z.number().optional(),
                retry: z
                  .object({
                    maxAttempts: z.number().int().positive().optional(),
                    backoffMs: z.number().int().positive().optional(),
                    backoffMultiplier: z.number().positive().optional(),
                    cooldownMs: z.number().int().nonnegative().optional(),
                  })
                  .optional(),
                idleShutdownMs: z.number().int().positive().optional(),
                toolFilter: z
                  .object({
                    include: z.array(z.string()).optional(),
                    exclude: z.array(z.string()).optional(),
                  })
                  .optional(),
                tools: z
                  .object({
                    approval: z.enum(["auto", "always", "per_session"]).optional(),
                    maxOutputBytes: z.number().int().positive().optional(),
                  })
                  .optional(),
                toolCache: z
                  .object({
                    mode: z.enum(["disabled", "session", "persistent"]).optional(),
                    ttlMs: z.number().int().positive().optional(),
                  })
                  .optional(),
              })
              .strict()
              .or(
                z
                  .object({
                    type: z.literal("remote"),
                    url: z.string(),
                    headers: z.record(z.string(), z.string()).optional(),
                    description: z.string().optional(),
                    timeout: z.number().optional(),
                    startup: z.enum(["eager", "lazy", "manual"]).optional(),
                    required: z.boolean().optional(),
                    connectTimeout: z.number().optional(),
                    listTimeout: z.number().optional(),
                    callTimeout: z.number().optional(),
                    retry: z
                      .object({
                        maxAttempts: z.number().int().positive().optional(),
                        backoffMs: z.number().int().positive().optional(),
                        backoffMultiplier: z.number().positive().optional(),
                        cooldownMs: z.number().int().nonnegative().optional(),
                      })
                      .optional(),
                    idleShutdownMs: z.number().int().positive().optional(),
                    toolFilter: z
                      .object({
                        include: z.array(z.string()).optional(),
                        exclude: z.array(z.string()).optional(),
                      })
                      .optional(),
                    tools: z
                      .object({
                        approval: z.enum(["auto", "always", "per_session"]).optional(),
                        maxOutputBytes: z.number().int().positive().optional(),
                      })
                      .optional(),
                    toolCache: z
                      .object({
                        mode: z.enum(["disabled", "session", "persistent"]).optional(),
                        ttlMs: z.number().int().positive().optional(),
                      })
                      .optional(),
                  })
                  .strict(),
              ),
          )
          .optional(),

        commands: z
          .array(
            z.object({
              name: z.string(),
              description: z.string(),
            }),
          )
          .optional(),

        config: z
          .object({
            schema: z.record(z.string(), z.any()).optional(),
            defaults: z.record(z.string(), z.any()).optional(),
          })
          .optional(),

        permissions: PluginPermissionsSchema,
        ui: UIContribution,
      })
      .partial()
      .optional(),

    // Lifecycle
    main: z.string().optional().default("./src/index.ts"),
    lifecycle: z
      .object({
        install: z.string().optional(),
        uninstall: z.string().optional(),
        update: z.string().optional(),
      })
      .optional(),

    // Runtime preferences
    runtime: z
      .object({
        mode: z.enum(["in-process", "worker", "process"]).optional(),
        minRuntimeApiVersion: z.string().optional(),
        resources: z
          .object({
            memoryMb: z.number().positive().optional(),
            startupTimeoutMs: z.number().positive().optional(),
            toolInvocationTimeoutMs: z.number().positive().optional(),
            hookInvocationTimeoutMs: z.number().positive().optional(),
            bridgeRequestTimeoutMs: z.number().positive().optional(),
            taskRunTimeoutMs: z.number().positive().optional(),
            shutdownGraceMs: z.number().positive().optional(),
            maxConcurrentRequests: z.number().positive().optional(),
            maxLogBytesPerMinute: z.number().positive().optional(),
            memoryPollIntervalMs: z.number().positive().optional(),
            heartbeatIntervalMs: z.number().positive().optional(),
            heartbeatMissesBeforeKill: z.number().positive().optional(),
          })
          .optional(),
      })
      .optional(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (manifest.contributes?.ui && manifest.permissions?.ui !== true) {
      ctx.addIssue({
        code: "custom",
        path: ["permissions", "ui"],
        message: "contributes.ui requires permissions.ui: true",
      })
    }
  })

export type PluginManifest = z.infer<typeof PluginManifest>
