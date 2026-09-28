import { z } from "zod"

export const InstalledInput = z.object({
  artifact: z.string(),
  profile: z.enum(["core", "full"]),
  mode: z.enum(["embedding", "sdk", "inspect", "seed", "continue"]),
  home: z.string(),
  workspace: z.string(),
  result: z.string(),
  prompt: z.string(),
  agent: z.string(),
  model: z.object({ providerID: z.string(), modelID: z.string() }),
  sessionID: z.string().optional(),
  attachment: z.string().optional(),
  attachmentID: z.string().optional(),
  coordination: z.string().optional(),
  deadlineMs: z.number().positive(),
})
export type InstalledInput = z.infer<typeof InstalledInput>

export const InstalledResult = z.object({
  sessionID: z.string(),
  completed: z.boolean(),
  answer: z.string(),
  messages: z.array(z.json()),
  before: z.array(z.json()),
  attachmentID: z.string().optional(),
  attachment: z.string().nullable(),
  components: z.array(z.string()),
  inventory: z.string(),
  resolved: z.record(z.string(), z.string()),
  closed: z.boolean(),
  terminal: z
    .object({ pid: z.number().int().positive(), output: z.string(), expected: z.string(), closed: z.boolean() })
    .optional(),
})
export type InstalledResult = z.infer<typeof InstalledResult>
