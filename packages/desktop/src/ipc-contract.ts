import z from "zod"
import {
  BrowserNativeAttachRequestSchema,
  BrowserNativePageRequestSchema,
  BrowserNativePresentationTicketRequestSchema,
  BrowserNativeResizeRequestSchema,
  type BrowserNativeAttachRequest,
  type BrowserNativePageRequest,
  type BrowserNativePresentationTicketRequest,
  type BrowserNativeResizeRequest,
} from "@ericsanchezok/synergy-browser"

const nonEmptyString = z.string().trim().min(1)

export const externalUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => {
      const protocol = new URL(value).protocol
      return protocol === "http:" || protocol === "https:" || protocol === "mailto:"
    },
    { message: "Only http, https, and mailto URLs can be opened externally" },
  )

export const clipboardWriteTextSchema = z.string()

export const selectDirectoryDialogRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    multiple: z.boolean().default(false),
  })
  .strict()

export const selectDirectoryDialogResponseSchema = z
  .object({
    canceled: z.boolean(),
    directoryPaths: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.canceled && value.directoryPaths.length !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Canceled directory picker responses cannot include paths",
      })
    }
    if (!value.canceled && value.directoryPaths.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Selected directory picker responses must include at least one path",
      })
    }
  })

export type SelectDirectoryDialogRequest = z.infer<typeof selectDirectoryDialogRequestSchema>
export type SelectDirectoryDialogResponse = z.infer<typeof selectDirectoryDialogResponseSchema>

export function parseBrowserNativeAttach(input: unknown): BrowserNativeAttachRequest {
  return BrowserNativeAttachRequestSchema.parse(input)
}

export function parseBrowserNativePage(input: unknown): BrowserNativePageRequest {
  return BrowserNativePageRequestSchema.parse(input)
}

export function parseBrowserNativeResize(input: unknown): BrowserNativeResizeRequest {
  return BrowserNativeResizeRequestSchema.parse(input)
}

export function parseBrowserNativePresentationTicket(input: unknown): BrowserNativePresentationTicketRequest {
  return BrowserNativePresentationTicketRequestSchema.parse(input)
}

export function parseExternalUrl(input: unknown): string {
  return externalUrlSchema.parse(input)
}

export function parseClipboardWriteText(input: unknown): string {
  return clipboardWriteTextSchema.parse(input)
}

export function parseSelectDirectoryDialogRequest(input: unknown): SelectDirectoryDialogRequest {
  return selectDirectoryDialogRequestSchema.parse(input)
}

export function parseSelectDirectoryDialogResponse(input: unknown): SelectDirectoryDialogResponse {
  return selectDirectoryDialogResponseSchema.parse(input)
}
