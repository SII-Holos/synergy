import z from "zod"

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

const PanelDef = z
  .object({
    id: z.string().min(1).max(64),
    label: z.string().min(1).max(64),
    icon: z.string().min(1),
    exportName: z.string().optional().default("default"),
    sandbox: z.boolean().optional().default(false),
    sandboxEntry: z
      .string()
      .regex(/^[a-zA-Z0-9_/.-]+\.js$/)
      .max(256)
      .optional(),
  })
  .strict()

const SettingsDef = z
  .object({
    id: z.string().min(1).max(64),
    label: z.string().min(1).max(64),
    icon: z.string().min(1),
    group: z.string(),
    formSchema: z.record(z.string(), z.unknown()).optional(),
    exportName: z.string().optional(),
    sandbox: z.boolean().optional().default(false),
    sandboxEntry: z
      .string()
      .regex(/^[a-zA-Z0-9_/.-]+\.js$/)
      .max(256)
      .optional(),
  })
  .strict()

const ChatComponentDef = z
  .object({
    id: z.string().min(1),
    exportName: z.string().optional().default("default"),
    slot: z.enum(["before-tools", "after-tools", "before-reasoning", "after-reasoning"]).optional(),
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

const RouteDef = z
  .object({
    path: z.string().min(1),
    entry: z.string().min(1),
    label: z.string().min(1),
    icon: z.string().optional(),
  })
  .strict()

const UICommandDef = z
  .object({
    id: z.string().min(1).max(64),
    label: z.string().min(1).max(64),
    exportName: z.string().optional(),
    description: z.string().max(256).optional(),
    icon: z.string().optional(),
  })
  .strict()

const UIContribution = z
  .object({
    entry: z
      .string()
      .regex(/^[a-zA-Z0-9_/.-]+\.js$/)
      .max(256)
      .optional(),
    minUIApiVersion: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .optional(),
    toolRenderers: z.array(ToolRendererDef).optional(),
    partRenderers: z.array(PartRendererDef).optional(),
    workspacePanels: z.array(PanelDef).optional(),
    globalPanels: z.array(PanelDef).optional(),
    settings: z.array(SettingsDef).optional(),
    chatComponents: z.array(ChatComponentDef).optional(),
    themes: z.array(ThemeDef).optional(),
    icons: z.array(IconDef).optional(),
    routes: z.array(RouteDef).optional(),
    commands: z.array(UICommandDef).optional(),
  })
  .partial()
  .optional()

const PluginPermissionsSchema = z
  .object({
    /** UI surface permissions */
    ui: z
      .object({
        toolRenderers: z.boolean().optional().default(false),
        partRenderers: z.boolean().optional().default(false),
        workspacePanels: z.boolean().optional().default(false),
        globalPanels: z.boolean().optional().default(false),
        settings: z.boolean().optional().default(false),
        themes: z.boolean().optional().default(false),
        icons: z.boolean().optional().default(false),
        routes: z.boolean().optional().default(false),
        /** Allow Tier 2 trusted host import (same-origin JS execution) */
        trustedImport: z.boolean().optional().default(false),
        /** Allow Tier 3 sandbox iframe */
        sandboxIframe: z.boolean().optional().default(false),
      })
      .partial()
      .optional(),

    /** Network access */
    network: z
      .object({
        /** Domains the plugin may connect to */
        connectDomains: z.array(z.string()).optional().default([]),
        /** Domains the plugin may fetch resources from (iframes, images) */
        resourceDomains: z.array(z.string()).optional().default([]),
        /** Domains allowed in iframe src */
        frameDomains: z.array(z.string()).optional().default([]),
      })
      .partial()
      .optional(),

    /** Data access */
    data: z
      .object({
        /** Session data access level */
        session: z.enum(["none", "metadata", "read"]).optional().default("none"),
        /** Workspace file access level */
        workspace: z.enum(["none", "metadata", "read"]).optional().default("none"),
        /** Config access scope */
        config: z.enum(["plugin", "global"]).optional().default("plugin"),
      })
      .partial()
      .optional(),

    /** Tool execution permissions */
    tools: z
      .object({
        /** Whether plugin tools can be invoked */
        invoke: z.boolean().optional().default(true),
        /** Whether plugin tools can access the shell */
        shell: z.boolean().optional().default(false),
        /** Whether plugin tools can access the filesystem */
        filesystem: z.boolean().optional().default(false),
      })
      .partial()
      .optional(),
  })
  .partial()
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

    // Compatibility
    minSynergyVersion: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .optional(),
    engines: z
      .object({
        synergy: z.string().optional(),
        bun: z.string().optional(),
      })
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
              name: z.string(),
              description: z.string(),
              kind: z.string().optional(),
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

        extensionPack: z.array(z.string()).optional(),
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
  })
  .strict()

export type PluginManifest = z.infer<typeof PluginManifest>
