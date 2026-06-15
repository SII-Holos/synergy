import z from "zod"

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
          .record(
            z.string(),
            z.discriminatedUnion("type", [
              z
                .object({
                  type: z.literal("local"),
                  command: z.array(z.string()),
                  environment: z.record(z.string(), z.string()).optional(),
                  description: z.string().optional(),
                  timeout: z.number().optional(),
                })
                .strict(),
              z
                .object({
                  type: z.literal("remote"),
                  url: z.string(),
                  headers: z.record(z.string(), z.string()).optional(),
                  description: z.string().optional(),
                  timeout: z.number().optional(),
                })
                .strict(),
            ]),
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
