import { z } from "zod"
import { BrowserNativePageRequestSchema } from "./protocol.js"

const requestId = z.string().min(1).max(200)
export const BrowserDataActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state") }).strict(),
  z
    .object({ type: z.literal("import"), kind: z.enum(["passwords", "cookies"]), overwrite: z.boolean(), requestId })
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
}
export type BrowserDataResult =
  | { type: "progress"; processed: number; total: number }
  | BrowserDataState
  | BrowserImportResult
  | { type: "done" }
