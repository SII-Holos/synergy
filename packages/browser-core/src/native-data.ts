import { z } from "zod"
import { BrowserNativePageRequestSchema } from "./protocol.js"

const requestId = z.string().min(1).max(200)
const importKind = z.enum(["passwords", "cookies"])
export type BrowserImportKind = z.infer<typeof importKind>
export type BrowserImportSource = {
  id: string
  browser: "chrome" | "edge" | "brave" | "safari" | "file"
  profile?: string
  mode: "direct" | "file"
  kinds: BrowserImportKind[]
}
export const BrowserDataActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state") }).strict(),
  z.object({ type: z.literal("importSources") }).strict(),
  z
    .object({
      type: z.literal("import"),
      sourceId: requestId,
      kinds: z
        .array(importKind)
        .min(1)
        .max(2)
        .refine((values) => new Set(values).size === values.length),
      overwrite: z.boolean(),
      requestId,
    })
    .strict(),
  z.object({ type: z.literal("importProgress"), requestId }).strict(),
  z.object({ type: z.literal("cancelImport"), requestId }).strict(),
  z.object({ type: z.literal("clearHistory") }).strict(),
  z.object({ type: z.literal("deletePassword"), id: requestId }).strict(),
  z.object({ type: z.literal("fillLogin"), id: requestId }).strict(),
  z.object({ type: z.literal("saveLogin") }).strict(),
])
export type BrowserDataAction = z.infer<typeof BrowserDataActionSchema>
export const BrowserDataRequestSchema = BrowserNativePageRequestSchema.extend({
  action: BrowserDataActionSchema,
}).strict()
export type BrowserDataRequest = z.infer<typeof BrowserDataRequestSchema>
export type BrowserDataState = {
  type: "state"
  passwordStorage: boolean
  passwords: Array<{ id: string; origin: string; username: string }>
  history: Array<{ url: string; title: string; time: number }>
}
export type BrowserImportResult = {
  type: "import"
  imported: number
  skipped: number
  failed: number
  cancelled: boolean
  issues: Array<{ row: number; reason: "invalid" | "expired" | "partitioned" | "storage" }>
  items: Array<{
    kind: BrowserImportKind
    imported: number
    skipped: number
    failed: number
    error?: "access" | "unavailable" | "format" | "storage"
  }>
}
export type BrowserDataResult =
  | { type: "sources"; sources: BrowserImportSource[] }
  | { type: "progress"; processed: number; total: number; phase: "reading" | "importing"; kind?: BrowserImportKind }
  | BrowserDataState
  | BrowserImportResult
  | { type: "done" }
