import z from "zod"
import type { BrowserNativeAttachRequest, BrowserNativeBounds } from "./browser-native-view.js"

const nonEmptyString = z.string().trim().min(1)

export const browserNativeBoundsSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  })
  .strict()

export const browserNativeAttachSchema = z
  .object({
    serverUrl: z.string().url().optional(),
    sessionID: nonEmptyString,
    routeDirectory: z.string().optional(),
    directory: z.string().optional(),
    scopeID: z.string().optional(),
    scopeKey: z.string().optional(),
    tabId: nonEmptyString,
    url: z.string().url().optional(),
    bounds: browserNativeBoundsSchema.optional(),
  })
  .strict()

export const browserNativeTabSchema = z
  .object({
    tabId: nonEmptyString,
  })
  .strict()

export const browserNativeResizeSchema = z
  .object({
    tabId: nonEmptyString,
    bounds: browserNativeBoundsSchema,
  })
  .strict()

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

export function parseBrowserNativeAttach(input: unknown): BrowserNativeAttachRequest {
  return browserNativeAttachSchema.parse(input)
}

export function parseBrowserNativeTab(input: unknown): { tabId: string } {
  return browserNativeTabSchema.parse(input)
}

export function parseBrowserNativeResize(input: unknown): { tabId: string; bounds: BrowserNativeBounds } {
  return browserNativeResizeSchema.parse(input)
}

export function parseExternalUrl(input: unknown): string {
  return externalUrlSchema.parse(input)
}
