import { z } from "zod"

export const PluginActivationJournal = z
  .object({
    version: z.literal(1),
    installs: z.array(
      z
        .object({
          name: z.string(),
          manifestHash: z.string(),
          source: z.enum(["local", "official", "npm", "git", "url", "builtin"]),
          approval: z.unknown(),
        })
        .strict(),
    ),
    removes: z.array(z.object({ id: z.string(), resolved: z.string() }).strict()),
  })
  .strict()
