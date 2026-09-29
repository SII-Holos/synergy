import { z } from "zod"
import { BrowserNativePageRequestSchema } from "./protocol.js"

export const BrowserPageActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state") }).strict(),
  z
    .object({ type: z.literal("find"), text: z.string().min(1).max(2_000), forward: z.boolean(), next: z.boolean() })
    .strict(),
  z.object({ type: z.literal("stopFind") }).strict(),
  z.object({ type: z.literal("zoom"), factor: z.number().min(0.25).max(5) }).strict(),
  z.object({ type: z.literal("print") }).strict(),
  z.object({ type: z.literal("pdf") }).strict(),
  z.object({ type: z.literal("capture"), fullPage: z.boolean() }).strict(),
])
export type BrowserPageAction = z.infer<typeof BrowserPageActionSchema>
export const BrowserPageActionRequestSchema = BrowserNativePageRequestSchema.extend({
  action: BrowserPageActionSchema,
}).strict()
export type BrowserPageActionRequest = z.infer<typeof BrowserPageActionRequestSchema>
export type BrowserPageActionResult =
  | { type: "state"; back: boolean; forward: boolean; zoom: number }
  | { type: "find"; matches: number; active: number }
  | { type: "zoom"; factor: number }
  | { type: "capture"; dataUrl: string; width: number; height: number; url: string; title: string; capturedAt: number }
  | { type: "done"; cancelled?: boolean }

export type BrowserShortcut =
  | "newTab"
  | "closeTab"
  | "address"
  | "find"
  | "reload"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "print"

export function browserShortcut(
  input: { type?: string; key: string; meta?: boolean; control?: boolean; alt?: boolean; shift?: boolean },
  platform: string,
): BrowserShortcut | undefined {
  if (input.type && input.type !== "keyDown") return
  if (input.alt || !(platform === "darwin" ? input.meta : input.control)) return
  const key = input.key.toLowerCase()
  if (input.shift && key !== "+" && key !== "=") return
  switch (key) {
    case "t":
      return "newTab"
    case "w":
      return "closeTab"
    case "l":
      return "address"
    case "f":
      return "find"
    case "r":
      return "reload"
    case "p":
      return "print"
    case "+":
    case "=":
      return "zoomIn"
    case "-":
      return "zoomOut"
    case "0":
      return "zoomReset"
  }
}

export const BrowserFileActionSchema = z
  .object({
    operation: z.enum(["save", "open", "copyImage"]),
    filename: z.string().min(1).max(1_024),
    mime: z.string().min(1).max(256),
    data: z.string().max(140 * 1024 * 1024),
  })
  .strict()
export type BrowserFileAction = z.infer<typeof BrowserFileActionSchema>
