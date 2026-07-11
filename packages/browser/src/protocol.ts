import z from "zod"

export const BROWSER_PROTOCOL_VERSION = 2 as const

export function browserOwnerKey(owner: { mode: "session" | "scope"; scopeID: string; sessionID?: string }): string {
  const encodePart = (value: string) => encodeURIComponent(toWellFormed(value))
  const scope = encodePart(owner.scopeID)
  return owner.mode === "session"
    ? `scope:${scope}:session:${encodePart(owner.sessionID ?? "")}`
    : `scope:${scope}:scope`
}

function toWellFormed(value: string): string {
  return Array.from(value, (character) => {
    if (character.length !== 1) return character
    const code = character.charCodeAt(0)
    return code >= 0xd800 && code <= 0xdfff ? "\uFFFD" : character
  }).join("")
}

const protocolVersion = z.literal(BROWSER_PROTOCOL_VERSION)
const nonEmpty = z.string().min(1).max(20_000)
export const BrowserRegistrationSecretSchema = z.string().regex(/^[a-f0-9]{64}$/i)
export const BrowserPageIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9._-]+$/)
const pageId = BrowserPageIdSchema
const browserURL = z.string().max(20_000)
const browserTitle = z.string().max(20_000)
const browserMessage = z.string().max(100_000)
const timeoutMs = z.number().int().min(100).max(120_000).optional()

export const BrowserSessionStatusSchema = z.enum(["empty", "suspended", "active", "migrating", "failed"])
export type BrowserSessionStatus = z.infer<typeof BrowserSessionStatusSchema>

export const BrowserHostStatusSchema = z.enum([
  "unavailable",
  "installing",
  "starting",
  "pending",
  "ready",
  "detached",
  "restarting",
  "idle",
  "failed",
])
export type BrowserHostStatus = z.infer<typeof BrowserHostStatusSchema>

export const BrowserPresentationKindSchema = z.enum(["native", "webrtc"])
export type BrowserPresentationKind = z.infer<typeof BrowserPresentationKindSchema>

export type BrowserPresentationPreference = "auto" | BrowserPresentationKind

export interface BrowserPresentationCapabilities {
  native: boolean
  webrtc: boolean
}

export interface BrowserPresentationEnvironment {
  desktopLocalHost: boolean
  remote: boolean
  requested?: BrowserPresentationPreference
  capabilities: BrowserPresentationCapabilities
}

export function parseBrowserPresentationPreference(value: string | null | undefined): BrowserPresentationPreference {
  if (value === "native" || value === "webrtc") return value
  return "auto"
}

export function normalizeBrowserURL(input: string, base?: string): string {
  const raw = input.trim()
  if (!raw) throw new Error("URL is required")
  if (/^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?(\/.*)?$/i.test(raw)) return `http://${raw}`
  if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(:\d+)?(\/.*)?$/.test(raw)) return `https://${raw}`
  if (base || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw)) {
    try {
      return new URL(raw, base).toString()
    } catch {}
  }
  return `https://www.google.com/search?q=${encodeURIComponent(raw)}`
}

export const BrowserPageSchema = z
  .object({
    id: pageId,
    url: browserURL,
    title: browserTitle,
    isLoading: z.boolean(),
    lastActiveAt: z.number().int().nullable(),
  })
  .strict()
export type BrowserPage = z.infer<typeof BrowserPageSchema>

export const BrowserCheckpointSchema = z
  .object({
    url: z
      .string()
      .max(20_000)
      .refine(
        (value) => value === "about:blank" || /^(https?|file):/i.test(value),
        "Checkpoint URL must use HTTP(S), file:, or about:blank.",
      ),
    cookies: z
      .array(z.record(z.string().max(2_048), z.unknown()))
      .max(10_000)
      .default([]),
    origins: z
      .array(
        z
          .object({
            origin: z.string().url().max(4_096),
            localStorage: z.record(z.string().max(10_000), z.string().max(1_000_000)).default({}),
            sessionStorage: z.record(z.string().max(10_000), z.string().max(1_000_000)).default({}),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    viewport: z
      .object({ width: z.number().int().min(1).max(16_384), height: z.number().int().min(1).max(16_384) })
      .strict(),
    scroll: z
      .object({
        x: z.number().min(-1_000_000_000).max(1_000_000_000),
        y: z.number().min(-1_000_000_000).max(1_000_000_000),
      })
      .strict(),
    formState: z
      .array(
        z
          .object({
            selector: z.string().min(1).max(10_000),
            value: z.string().max(100_000).optional(),
            checked: z.boolean().optional(),
            selectedValues: z.array(z.string().max(20_000)).max(1_000).optional(),
            contentEditable: z.boolean().optional(),
          })
          .strict(),
      )
      .max(500)
      .default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 32 * 1024 * 1024) {
      ctx.addIssue({ code: "custom", message: "Browser checkpoint exceeds the 32 MB limit." })
    }
  })
export type BrowserCheckpoint = z.infer<typeof BrowserCheckpointSchema>

export const BrowserPresentationSchema = z
  .object({
    protocolVersion,
    kind: BrowserPresentationKindSchema,
    capabilities: z.object({ native: z.boolean(), webrtc: z.boolean() }).strict(),
    reason: z.enum(["desktop-local", "remote-client", "requested"]),
  })
  .strict()
export type BrowserPresentation = z.infer<typeof BrowserPresentationSchema>
export type BrowserPresentationSelection = BrowserPresentation | null

export const BrowserNativeBoundsSchema = z
  .object({
    x: z.number().finite().min(-32_768).max(32_768),
    y: z.number().finite().min(-32_768).max(32_768),
    width: z.number().finite().positive().max(16_384),
    height: z.number().finite().positive().max(16_384),
  })
  .strict()
export type BrowserNativeBounds = z.infer<typeof BrowserNativeBoundsSchema>

export const BrowserNativePageRequestSchema = z.object({ protocolVersion, ownerKey: nonEmpty, pageId }).strict()
export type BrowserNativePageRequest = z.infer<typeof BrowserNativePageRequestSchema>

export const BrowserNativeAttachRequestSchema = BrowserNativePageRequestSchema.extend({
  bounds: BrowserNativeBoundsSchema.optional(),
}).strict()
export type BrowserNativeAttachRequest = z.infer<typeof BrowserNativeAttachRequestSchema>

export const BrowserNativeResizeRequestSchema = BrowserNativePageRequestSchema.extend({
  bounds: BrowserNativeBoundsSchema,
}).strict()
export type BrowserNativeResizeRequest = z.infer<typeof BrowserNativeResizeRequestSchema>

export const BrowserNativePresentationTicketRequestSchema = z
  .object({ protocolVersion, serverUrl: z.string().url().max(20_000), ownerKey: nonEmpty })
  .strict()
export type BrowserNativePresentationTicketRequest = z.infer<typeof BrowserNativePresentationTicketRequestSchema>

export const BrowserNativeViewEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("native.loading"), protocolVersion, pageId, url: browserURL.optional() }).strict(),
  z
    .object({
      type: z.literal("native.loaded"),
      protocolVersion,
      pageId,
      url: browserURL.optional(),
      title: browserTitle.optional(),
    })
    .strict(),
  z.object({ type: z.literal("native.navigated"), protocolVersion, pageId, url: browserURL }).strict(),
  z.object({ type: z.literal("native.title"), protocolVersion, pageId, title: browserTitle }).strict(),
  z
    .object({
      type: z.literal("native.error"),
      protocolVersion,
      pageId,
      code: z.number().int().optional(),
      message: browserMessage,
      url: browserURL.optional(),
    })
    .strict(),
])
export type BrowserNativeViewEvent = z.infer<typeof BrowserNativeViewEventSchema>

export function selectBrowserPresentation(input: BrowserPresentationEnvironment): BrowserPresentationSelection {
  const requested = input.requested ?? "auto"
  if (requested === "native" && input.capabilities.native && input.desktopLocalHost && !input.remote) {
    return {
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      kind: "native",
      capabilities: input.capabilities,
      reason: "requested",
    }
  }
  if (requested === "webrtc" && input.capabilities.webrtc) {
    return {
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      kind: "webrtc",
      capabilities: input.capabilities,
      reason: "requested",
    }
  }
  if (input.capabilities.native && input.desktopLocalHost && !input.remote) {
    return {
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      kind: "native",
      capabilities: input.capabilities,
      reason: "desktop-local",
    }
  }
  if (!input.capabilities.webrtc) return null
  return {
    protocolVersion: BROWSER_PROTOCOL_VERSION,
    kind: "webrtc",
    capabilities: input.capabilities,
    reason: "remote-client",
  }
}

interface LocatorScope {
  within?: BrowserLocator
  framePath?: BrowserLocator[]
}

export type BrowserLocator =
  | { kind: "ref"; snapshotId: string; ref: string; within?: never; framePath?: never }
  | (LocatorScope &
      (
        | { kind: "testId"; value: string }
        | { kind: "role"; role: string; name?: string; exact?: boolean }
        | { kind: "label"; text: string; exact?: boolean }
        | { kind: "placeholder"; text: string; exact?: boolean }
        | { kind: "text"; text: string; exact?: boolean }
        | { kind: "css"; value: string }
        | { kind: "xpath"; value: string }
      ))

const MAX_LOCATOR_DEPTH = 8
const MAX_LOCATOR_NODES = 128

function locatorWithinBounds(input: unknown): boolean {
  const pending = [{ value: input, depth: 0, allowFramePath: true }]
  const seen = new Set<object>()
  let nodes = 0
  while (pending.length) {
    const current = pending.pop()!
    if (!current.value || typeof current.value !== "object" || Array.isArray(current.value)) continue
    if (seen.has(current.value)) return false
    seen.add(current.value)
    nodes++
    if (nodes > MAX_LOCATOR_NODES || current.depth > MAX_LOCATOR_DEPTH) return false
    const record = current.value as Record<string, unknown>
    if (record.within !== undefined)
      pending.push({ value: record.within, depth: current.depth + 1, allowFramePath: false })
    if (Array.isArray(record.framePath)) {
      if (!current.allowFramePath) return false
      for (const frame of record.framePath)
        pending.push({ value: frame, depth: current.depth + 1, allowFramePath: false })
    }
  }
  return true
}

function scopeShape() {
  return {
    within: BrowserLocatorInnerSchema.optional(),
    framePath: z.array(BrowserLocatorInnerSchema).max(8).optional(),
  }
}

const BrowserLocatorInnerSchema: z.ZodType<BrowserLocator> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("ref"), snapshotId: nonEmpty, ref: nonEmpty }).strict(),
    z.object({ kind: z.literal("testId"), value: nonEmpty, ...scopeShape() }).strict(),
    z
      .object({
        kind: z.literal("role"),
        role: nonEmpty,
        name: z.string().max(20_000).optional().describe("Accessible name for the requested role."),
        exact: z.boolean().optional().describe("Match the accessible name exactly instead of by substring."),
        ...scopeShape(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("label"),
        text: nonEmpty.describe("Label text associated with a form control; use role/name for named buttons."),
        exact: z.boolean().optional().describe("Match the label text exactly instead of by substring."),
        ...scopeShape(),
      })
      .strict(),
    z
      .object({ kind: z.literal("placeholder"), text: nonEmpty, exact: z.boolean().optional(), ...scopeShape() })
      .strict(),
    z.object({ kind: z.literal("text"), text: nonEmpty, exact: z.boolean().optional(), ...scopeShape() }).strict(),
    z.object({ kind: z.literal("css"), value: nonEmpty, ...scopeShape() }).strict(),
    z.object({ kind: z.literal("xpath"), value: nonEmpty, ...scopeShape() }).strict(),
  ]),
)

export const BrowserLocatorSchema: z.ZodType<BrowserLocator> = z.preprocess((input, context) => {
  if (locatorWithinBounds(input)) return input
  context.addIssue({ code: "custom", message: "Browser locator scopes exceed the depth or node limit." })
  return z.NEVER
}, BrowserLocatorInnerSchema)

export const BrowserPointSchema = z
  .object({
    kind: z.literal("point"),
    x: z.number().nonnegative().max(32_768),
    y: z.number().nonnegative().max(32_768),
  })
  .strict()
export type BrowserPoint = z.infer<typeof BrowserPointSchema>

export const BrowserTargetSchema = z.union([BrowserLocatorSchema, BrowserPointSchema])
export type BrowserTarget = z.infer<typeof BrowserTargetSchema>

export const BrowserModifierSchema = z.enum(["Alt", "Control", "ControlOrMeta", "Meta", "Shift"])
export type BrowserModifier = z.infer<typeof BrowserModifierSchema>

const actionBase = {
  timeoutMs: timeoutMs.describe("Maximum time for locator resolution and actionability checks."),
  includeSnapshot: z.boolean().optional().describe("Return a fresh accessibility snapshot after the action."),
}

export const BrowserActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("click"),
      target: BrowserTargetSchema,
      button: z.enum(["left", "middle", "right"]).optional(),
      modifiers: z.array(BrowserModifierSchema).max(5).optional(),
      ...actionBase,
    })
    .strict(),
  z
    .object({
      type: z.literal("dblclick"),
      target: BrowserTargetSchema,
      button: z.enum(["left", "middle", "right"]).optional(),
      modifiers: z.array(BrowserModifierSchema).max(5).optional(),
      ...actionBase,
    })
    .strict(),
  z
    .object({ type: z.literal("fill"), target: BrowserLocatorSchema, value: z.string().max(1_000_000), ...actionBase })
    .strict(),
  z
    .object({
      type: z.literal("type"),
      target: BrowserLocatorSchema.optional(),
      value: z.string().max(1_000_000),
      delayMs: z.number().int().min(0).max(1_000).optional(),
      ...actionBase,
    })
    .strict(),
  z
    .object({
      type: z.literal("press"),
      target: BrowserLocatorSchema.optional(),
      key: z.string().min(1).max(100),
      modifiers: z.array(BrowserModifierSchema).max(5).optional(),
      ...actionBase,
    })
    .strict(),
  z
    .object({
      type: z.literal("select"),
      target: BrowserLocatorSchema,
      values: z
        .array(
          z.union([
            nonEmpty,
            z
              .object({
                value: z.string().max(20_000).optional(),
                label: z.string().max(20_000).optional(),
                index: z.number().int().min(0).optional(),
              })
              .strict()
              .refine(
                (value) => [value.value, value.label, value.index].filter((entry) => entry !== undefined).length === 1,
                {
                  message: "Select options require exactly one of value, label, or index.",
                },
              ),
          ]),
        )
        .min(1)
        .max(100)
        .describe(
          'Options to select. A string matches the HTML option value exactly; use {label: "Visible text"} to select by displayed label or {index: 0} by zero-based index.',
        ),
      ...actionBase,
    })
    .strict(),
  z
    .object({ type: z.literal("setChecked"), target: BrowserLocatorSchema, checked: z.boolean(), ...actionBase })
    .strict(),
  z.object({ type: z.literal("hover"), target: BrowserLocatorSchema, ...actionBase }).strict(),
  z
    .object({
      type: z.literal("drag"),
      from: BrowserTargetSchema,
      to: BrowserTargetSchema,
      modifiers: z.array(BrowserModifierSchema).max(5).optional(),
      ...actionBase,
    })
    .strict(),
  z
    .object({
      type: z.literal("scroll"),
      target: BrowserTargetSchema.optional(),
      deltaX: z.number().min(-1_000_000_000).max(1_000_000_000).describe("Horizontal CSS pixels."),
      deltaY: z.number().min(-1_000_000_000).max(1_000_000_000).describe("Vertical CSS pixels."),
      ...actionBase,
    })
    .strict(),
])
export type BrowserAction = z.infer<typeof BrowserActionSchema>

export const BrowserWaitConditionSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("load"), state: z.enum(["domcontentloaded", "load", "networkidle"]).default("load") })
    .strict(),
  z
    .object({ type: z.literal("url"), value: nonEmpty, match: z.enum(["contains", "equals"]).default("contains") })
    .strict(),
  z
    .object({ type: z.literal("title"), value: nonEmpty, match: z.enum(["contains", "equals"]).default("contains") })
    .strict(),
  z
    .object({
      type: z.literal("text"),
      values: z.array(nonEmpty).min(1).max(20),
      match: z.enum(["any", "all"]).default("any"),
    })
    .strict(),
  z
    .object({
      type: z.literal("locator"),
      locator: BrowserLocatorSchema,
      state: z.enum(["attached", "detached", "visible", "hidden", "enabled", "disabled"]),
    })
    .strict(),
  z.object({ type: z.literal("download") }).strict(),
  z.object({ type: z.literal("dialog") }).strict(),
])
export type BrowserWaitCondition = z.infer<typeof BrowserWaitConditionSchema>

export const BrowserClipSchema = z
  .object({
    x: z.number().nonnegative(),
    y: z.number().nonnegative(),
    width: z.number().positive().max(32_768),
    height: z.number().positive().max(32_768),
  })
  .strict()

export const BrowserEmulationSchema = z
  .object({
    viewport: z
      .object({
        width: z.number().int().min(1).max(16_384),
        height: z.number().int().min(1).max(16_384),
        deviceScaleFactor: z.number().min(0.1).max(10).optional(),
      })
      .strict()
      .optional(),
    mobile: z.boolean().optional(),
    touch: z.boolean().optional(),
    colorScheme: z.enum(["light", "dark", "no-preference"]).optional(),
    reducedMotion: z.enum(["reduce", "no-preference"]).optional(),
    forcedColors: z.enum(["active", "none"]).optional(),
    locale: z.string().max(256).optional(),
    timezone: z.string().max(256).optional(),
    cpuThrottlingRate: z.number().min(1).max(20).optional(),
    networkProfile: z.enum(["online", "offline", "slow-3g", "fast-3g", "slow-4g"]).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one emulation setting is required.")
export type BrowserEmulation = z.infer<typeof BrowserEmulationSchema>

const BrowserUserNavigateCommandSchema = z
  .object({ type: z.literal("navigate"), url: nonEmpty, source: z.literal("user").default("user") })
  .strict()
const BrowserHistoryCommandSchema = z
  .object({ type: z.literal("history"), direction: z.enum(["back", "forward"]) })
  .strict()
const BrowserReloadCommandSchema = z.object({ type: z.literal("reload"), ignoreCache: z.boolean().optional() }).strict()
const BrowserStopCommandSchema = z.object({ type: z.literal("stop") }).strict()
const BrowserResumeCommandSchema = z.object({ type: z.literal("resume") }).strict()
const BrowserCloseCommandSchema = z.object({ type: z.literal("close") }).strict()
const BrowserViewportCommandSchema = z
  .object({
    type: z.literal("setViewport"),
    width: z.number().int().min(1).max(16_384),
    height: z.number().int().min(1).max(16_384),
  })
  .strict()
const BrowserDialogResponseCommandSchema = z
  .object({
    type: z.literal("dialog.respond"),
    requestId: nonEmpty,
    accept: z.boolean(),
    promptText: z.string().max(1_000_000).optional(),
  })
  .strict()
const BrowserUploadFileSchema = z
  .object({
    name: z.string().min(1).max(1_024),
    mimeType: z.string().max(256),
    dataBase64: z
      .string()
      .min(1)
      .max(35 * 1024 * 1024)
      .superRefine((value, ctx) => {
        const bytes = decodedBase64Bytes(value)
        if (bytes === null) ctx.addIssue({ code: "custom", message: "Upload content is not valid base64." })
        else if (bytes > 25 * 1024 * 1024)
          ctx.addIssue({ code: "custom", message: "Upload file exceeds the 25 MB limit." })
      }),
  })
  .strict()
const BrowserUploadFilesSchema = z
  .array(BrowserUploadFileSchema)
  .max(20)
  .superRefine((files, ctx) => {
    const bytes = files.reduce((total, file) => total + (decodedBase64Bytes(file.dataBase64) ?? 0), 0)
    if (bytes > 50 * 1024 * 1024) ctx.addIssue({ code: "custom", message: "Upload request exceeds the 50 MB limit." })
  })
const BrowserFileChooserCommandSchema = z
  .object({
    type: z.literal("filechooser.select"),
    requestId: nonEmpty,
    files: BrowserUploadFilesSchema,
  })
  .strict()

const browserUserCommandSchemas = [
  BrowserUserNavigateCommandSchema,
  BrowserHistoryCommandSchema,
  BrowserReloadCommandSchema,
  BrowserStopCommandSchema,
  BrowserResumeCommandSchema,
  BrowserCloseCommandSchema,
  BrowserViewportCommandSchema,
  BrowserDialogResponseCommandSchema,
  BrowserFileChooserCommandSchema,
] as const

export const BrowserUserCommandSchema = z.discriminatedUnion("type", browserUserCommandSchemas)
export type BrowserUserCommand = z.infer<typeof BrowserUserCommandSchema>

const backendOnlyCommands = [
  z
    .object({
      type: z.literal("snapshot"),
      query: z.string().max(20_000).optional(),
      maxNodes: z.number().int().min(1).max(5_000).default(500),
    })
    .strict(),
  z.object({ type: z.literal("action"), action: BrowserActionSchema }).strict(),
  z
    .object({
      type: z.literal("wait"),
      condition: BrowserWaitConditionSchema,
      timeoutMs: z.number().int().min(500).max(60_000).default(10_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("evaluate"),
      mode: z.enum(["readonly", "trusted"]),
      expression: z.string().min(1).max(1_000_000),
      timeoutMs: timeoutMs.default(10_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("screenshot"),
      fullPage: z.literal(true).optional(),
      clip: BrowserClipSchema.optional(),
      target: BrowserLocatorSchema.optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      const modes =
        Number(value.fullPage === true) + Number(value.clip !== undefined) + Number(value.target !== undefined)
      if (modes > 1) {
        ctx.addIssue({ code: "custom", message: "Choose only one of fullPage, clip, or target." })
      }
    }),
  z
    .object({
      type: z.literal("read"),
      format: z.enum(["text", "markdown", "html"]),
      target: BrowserLocatorSchema.optional(),
      maxChars: z.number().int().min(1).max(200_000).default(20_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("inspect"),
      target: BrowserLocatorSchema,
      computedStyles: z.array(z.string().min(1).max(1_000)).max(100).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("console"),
      action: z.enum(["list", "get", "clear"]),
      id: z.string().max(20_000).optional(),
      level: z.string().max(1_000).optional(),
      filter: z.string().max(20_000).optional(),
      page: z.number().int().min(0).optional(),
      pageSize: z.number().int().min(1).max(500).optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      const listFields = ["level", "filter", "page", "pageSize"] as const
      if (value.action === "get" && !value.id)
        ctx.addIssue({ code: "custom", path: ["id"], message: "id is required for get." })
      if (value.action !== "get" && value.id !== undefined)
        ctx.addIssue({ code: "custom", path: ["id"], message: "id is valid only for get." })
      if (value.action !== "list") {
        for (const field of listFields) {
          if (value[field] !== undefined)
            ctx.addIssue({ code: "custom", path: [field], message: `${field} is valid only for list.` })
        }
      }
    }),
  z
    .object({
      type: z.literal("network"),
      action: z.enum(["list", "get", "clear"]),
      id: z.string().max(20_000).optional(),
      resourceTypes: z.array(z.string().max(1_000)).max(100).optional(),
      status: z.number().int().optional(),
      page: z.number().int().min(0).optional(),
      pageSize: z.number().int().min(1).max(500).optional(),
      includeBody: z.boolean().optional(),
      includeSensitive: z.boolean().optional(),
      maxBodyBytes: z
        .number()
        .int()
        .min(1)
        .max(10 * 1024 * 1024)
        .optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      const listFields = ["resourceTypes", "status", "page", "pageSize"] as const
      const getFields = ["includeBody", "maxBodyBytes"] as const
      if (value.action === "get" && !value.id)
        ctx.addIssue({ code: "custom", path: ["id"], message: "id is required for get." })
      if (value.action !== "get" && value.id !== undefined)
        ctx.addIssue({ code: "custom", path: ["id"], message: "id is valid only for get." })
      if (value.action !== "list") {
        for (const field of listFields) {
          if (value[field] !== undefined)
            ctx.addIssue({ code: "custom", path: [field], message: `${field} is valid only for list.` })
        }
      }
      if (value.action !== "get") {
        for (const field of getFields) {
          if (value[field] !== undefined)
            ctx.addIssue({ code: "custom", path: [field], message: `${field} is valid only for get.` })
        }
      }
      if (value.action === "clear" && value.includeSensitive !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["includeSensitive"],
          message: "includeSensitive is valid only for list or get.",
        })
      }
    }),
  z
    .object({
      type: z.literal("performance"),
      action: z.enum(["measure", "startTrace", "stopTrace"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("audit"),
      categories: z
        .array(z.enum(["accessibility", "semantic", "seo", "best-practices"]))
        .min(1)
        .optional(),
    })
    .strict(),
  z.object({ type: z.literal("emulate"), emulation: BrowserEmulationSchema }).strict(),
  z
    .object({
      type: z.literal("dialog"),
      action: z.enum(["status", "accept", "dismiss"]),
      promptText: z.string().max(1_000_000).optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.action !== "accept" && value.promptText !== undefined) {
        ctx.addIssue({ code: "custom", path: ["promptText"], message: "promptText is valid only for accept." })
      }
    }),
  z
    .object({
      type: z.literal("clipboard"),
      action: z.enum(["read", "write", "clear"]),
      text: z
        .string()
        .max(1_000_000)
        .refine((value) => new TextEncoder().encode(value).byteLength <= 1024 * 1024, "Clipboard text exceeds 1 MB.")
        .optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.action === "write" && value.text === undefined) {
        ctx.addIssue({ code: "custom", path: ["text"], message: "text is required for write." })
      }
      if (value.action !== "write" && value.text !== undefined) {
        ctx.addIssue({ code: "custom", path: ["text"], message: "text is valid only for write." })
      }
    }),
  z
    .object({
      type: z.literal("upload"),
      target: BrowserLocatorSchema,
      files: BrowserUploadFilesSchema.min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("checkpoint"),
      action: z.enum(["capture", "restore"]),
      checkpoint: BrowserCheckpointSchema.optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.action === "restore" && !value.checkpoint)
        ctx.addIssue({ code: "custom", path: ["checkpoint"], message: "checkpoint is required for restore." })
      if (value.action === "capture" && value.checkpoint)
        ctx.addIssue({ code: "custom", path: ["checkpoint"], message: "checkpoint is valid only for restore." })
    }),
  z.object({ type: z.literal("download.cancel"), id: nonEmpty }).strict(),
] as const

const BrowserBackendNavigateCommandSchema = z
  .object({ type: z.literal("navigate"), url: nonEmpty, source: z.enum(["user", "agent"]) })
  .strict()

export const BrowserBackendCommandSchema = z.discriminatedUnion("type", [
  BrowserBackendNavigateCommandSchema,
  BrowserHistoryCommandSchema,
  BrowserReloadCommandSchema,
  BrowserStopCommandSchema,
  BrowserResumeCommandSchema,
  BrowserCloseCommandSchema,
  BrowserViewportCommandSchema,
  BrowserDialogResponseCommandSchema,
  BrowserFileChooserCommandSchema,
  ...backendOnlyCommands,
])
export type BrowserBackendCommand = z.input<typeof BrowserBackendCommandSchema>
export type BrowserParsedBackendCommand = z.infer<typeof BrowserBackendCommandSchema>

export const BrowserSnapshotElementSchema = z
  .object({
    ref: nonEmpty,
    role: z.string().max(1_000),
    name: browserMessage,
    value: browserMessage.optional(),
    description: browserMessage.optional(),
    depth: z.number().int().nonnegative().max(10_000),
  })
  .strict()
export type BrowserSnapshotElement = z.infer<typeof BrowserSnapshotElementSchema>

export const BrowserBackendResultSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("void") }).strict(),
  z.object({ type: z.literal("page"), page: BrowserPageSchema }).strict(),
  z.object({ type: z.literal("navigation"), page: BrowserPageSchema }).strict(),
  z
    .object({
      type: z.literal("snapshot"),
      pageId,
      snapshotId: nonEmpty,
      elements: z.array(BrowserSnapshotElementSchema),
      truncated: z.boolean(),
    })
    .strict(),
  z.object({ type: z.literal("action"), pageId, action: nonEmpty, snapshot: z.unknown().optional() }).strict(),
  z.object({ type: z.literal("wait"), pageId, matched: z.boolean() }).strict(),
  z.object({ type: z.literal("evaluation"), pageId, value: z.unknown() }).strict(),
  z
    .object({
      type: z.literal("screenshot"),
      pageId,
      dataUrl: z
        .string()
        .min(1)
        .max(35 * 1024 * 1024),
      width: z.number().int().nonnegative(),
      height: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ type: z.literal("data"), pageId, data: z.unknown() }).strict(),
])
export type BrowserBackendResult = z.infer<typeof BrowserBackendResultSchema>

export const BrowserDownloadEntrySchema = z
  .object({
    id: nonEmpty,
    url: browserURL,
    fileName: z.string().min(1).max(1_024),
    mimeType: z.string().max(256),
    state: z.enum(["in_progress", "completed", "cancelled", "interrupted", "blocked"]),
    totalBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    receivedBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    timestamp: z.number().int().nonnegative(),
    warning: browserMessage.optional(),
  })
  .strict()
export type BrowserDownloadEntry = z.infer<typeof BrowserDownloadEntrySchema>

export const BrowserHostDownloadEntrySchema = BrowserDownloadEntrySchema.extend({
  path: z.string().max(20_000).optional(),
}).strict()
export type BrowserHostDownloadEntry = z.infer<typeof BrowserHostDownloadEntrySchema>

export const BrowserHostPageEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("page.updated"), page: BrowserPageSchema }).strict(),
  z.object({ type: z.literal("page.loading"), pageId, url: browserURL }).strict(),
  z.object({ type: z.literal("page.loaded"), page: BrowserPageSchema }).strict(),
  z.object({ type: z.literal("page.error"), pageId, url: browserURL.optional(), message: browserMessage }).strict(),
  z
    .object({
      type: z.literal("dialog.opened"),
      pageId,
      requestId: nonEmpty,
      dialogType: z.string().max(1_000),
      message: browserMessage,
      defaultValue: browserMessage.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("filechooser.request"),
      pageId,
      requestId: nonEmpty,
      multiple: z.boolean(),
      accept: z.array(z.string().max(1_000)).max(100),
    })
    .strict(),
  z.object({ type: z.literal("download.updated"), pageId, entry: BrowserHostDownloadEntrySchema }).strict(),
])
export type BrowserHostPageEvent = z.infer<typeof BrowserHostPageEventSchema>

export const BrowserControlRequestSchema = z
  .object({
    protocolVersion,
    command: BrowserUserCommandSchema,
    commandId: nonEmpty,
    traceId: nonEmpty.optional(),
  })
  .strict()
  .meta({ ref: "BrowserControlRequest" })
export type BrowserControlRequest = z.infer<typeof BrowserControlRequestSchema>

export const BrowserIceServerSchema = z
  .object({
    urls: z.union([nonEmpty, z.array(nonEmpty).min(1)]),
    username: z.string().max(20_000).optional(),
    credential: z.string().max(20_000).optional(),
  })
  .strict()
export type BrowserIceServer = z.infer<typeof BrowserIceServerSchema>

export const BrowserViewerTicketRequestSchema = z
  .object({ protocolVersion, pageId })
  .strict()
  .meta({ ref: "BrowserViewerTicketRequest" })
export type BrowserViewerTicketRequest = z.infer<typeof BrowserViewerTicketRequestSchema>

export const BrowserViewerTicketResponseSchema = z
  .object({
    protocolVersion,
    ticket: nonEmpty,
    expiresAt: z.number().int().positive(),
    iceServers: z.array(BrowserIceServerSchema).max(100),
  })
  .strict()
  .meta({ ref: "BrowserViewerTicketResponse" })
export type BrowserViewerTicketResponse = z.infer<typeof BrowserViewerTicketResponseSchema>

export const BrowserAnnotationRequestSchema = z
  .object({
    protocolVersion,
    pageId,
    x: z.number(),
    y: z.number(),
    comment: z.string().min(1).max(20_000),
    styleFeedback: z.record(z.string().max(1_000), z.string().max(10_000)).optional(),
  })
  .strict()
  .meta({ ref: "BrowserAnnotationRequest" })

export const BrowserAnnotationResponseSchema = z
  .object({
    protocolVersion,
    annotation: z
      .object({
        id: nonEmpty,
        pageURL: browserURL,
        pageID: nonEmpty,
        element: browserMessage.optional(),
        comment: z.string().min(1).max(20_000),
        styleFeedback: z.record(z.string().max(1_000), z.string().max(10_000)).optional(),
        resolved: z.boolean(),
        createdAt: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .meta({ ref: "BrowserAnnotationResponse" })

export const BrowserDiagnosticsRequestSchema = z
  .object({
    protocolVersion,
    pageId,
    commandId: nonEmpty,
    action: z.enum(["console", "network", "elements", "assets", "downloads", "clear"]),
    limit: z.number().int().min(1).max(500).default(200),
  })
  .strict()
  .meta({ ref: "BrowserDiagnosticsRequest" })

export const BrowserDiagnosticsResponseSchema = z
  .object({ protocolVersion, pageId, action: z.string().max(1_000), data: z.unknown() })
  .strict()
  .meta({ ref: "BrowserDiagnosticsResponse" })

export const BrowserControlResponseSchema = z
  .object({
    type: z.literal("control.result"),
    protocolVersion,
    result: BrowserBackendResultSchema,
  })
  .strict()
  .meta({ ref: "BrowserControlResponse" })

const BrowserObstructionCandidateSchema = z
  .object({
    tag: z.string().max(1_000).optional(),
    role: z.string().max(1_000).nullable().optional(),
    name: z.string().max(1_000).optional(),
    id: z.string().max(1_000).optional(),
    class: z.string().max(1_000).optional(),
  })
  .strict()

export const BrowserObstructionSchema = BrowserObstructionCandidateSchema.extend({
  candidates: z.array(BrowserObstructionCandidateSchema).max(5).optional(),
}).strict()
export type BrowserObstruction = z.infer<typeof BrowserObstructionSchema>

export const BrowserProtocolErrorSchema = z
  .object({
    type: z.literal("error"),
    code: z.string().min(1).max(1_000),
    message: z.string().min(1).max(100_000),
    retryable: z.boolean(),
    pageId: pageId.optional(),
    commandId: nonEmpty.optional(),
    url: browserURL.optional(),
    locator: BrowserLocatorSchema.optional(),
    snapshotId: nonEmpty.optional(),
    obstruction: BrowserObstructionSchema.optional(),
    suggestedAction: browserMessage.optional(),
  })
  .strict()
  .meta({ ref: "BrowserProtocolError" })
export type BrowserProtocolErrorData = z.infer<typeof BrowserProtocolErrorSchema>

export const BrowserSessionStateSchema = z
  .object({
    type: z.literal("session.state"),
    protocolVersion,
    ownerKey: nonEmpty,
    status: BrowserSessionStatusSchema,
    page: BrowserPageSchema.nullable(),
    presentation: BrowserPresentationSchema.nullable(),
    hostStatus: BrowserHostStatusSchema,
    seq: z.number().int().nonnegative(),
    epoch: nonEmpty,
    error: BrowserProtocolErrorSchema.optional(),
  })
  .strict()
  .meta({ ref: "BrowserSessionState" })
export type BrowserSessionState = z.infer<typeof BrowserSessionStateSchema>

export const BrowserAPIErrorSchema = BrowserProtocolErrorSchema.omit({ locator: true })
  .extend({ locator: z.unknown().optional() })
  .meta({ ref: "BrowserAPIError" })

export const BrowserAPISessionStateSchema = BrowserSessionStateSchema.omit({ error: true })
  .extend({ error: BrowserAPIErrorSchema.optional() })
  .meta({ ref: "BrowserAPISessionState" })
export type BrowserAPISessionState = z.infer<typeof BrowserAPISessionStateSchema>

export const BrowserEventSchema = z.discriminatedUnion("type", [
  BrowserSessionStateSchema,
  z
    .object({
      type: z.literal("page.created"),
      protocolVersion,
      seq: z.number().int().nonnegative(),
      epoch: nonEmpty,
      page: BrowserPageSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("page.updated"),
      protocolVersion,
      seq: z.number().int().nonnegative(),
      epoch: nonEmpty,
      page: BrowserPageSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("page.closed"),
      protocolVersion,
      seq: z.number().int().nonnegative(),
      epoch: nonEmpty,
      pageId,
    })
    .strict(),
  z
    .object({
      type: z.literal("page.loading"),
      protocolVersion,
      seq: z.number().int().nonnegative(),
      epoch: nonEmpty,
      pageId,
      url: browserURL,
    })
    .strict(),
  z
    .object({
      type: z.literal("page.loaded"),
      protocolVersion,
      seq: z.number().int().nonnegative(),
      epoch: nonEmpty,
      page: BrowserPageSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("page.error"),
      protocolVersion,
      seq: z.number().int().nonnegative(),
      epoch: nonEmpty,
      pageId,
      url: browserURL.optional(),
      message: browserMessage,
    })
    .strict(),
  z
    .object({
      type: z.literal("host.status"),
      protocolVersion,
      seq: z.number().int().nonnegative(),
      epoch: nonEmpty,
      status: BrowserHostStatusSchema,
      pageId: pageId.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("download.updated"),
      protocolVersion,
      seq: z.number().int().nonnegative(),
      epoch: nonEmpty,
      pageId,
      entry: BrowserDownloadEntrySchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("filechooser.request"),
      protocolVersion,
      seq: z.number().int().nonnegative(),
      epoch: nonEmpty,
      pageId,
      requestId: nonEmpty,
      multiple: z.boolean(),
      accept: z.array(z.string().max(1_000)).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("dialog.opened"),
      protocolVersion,
      seq: z.number().int().nonnegative(),
      epoch: nonEmpty,
      pageId,
      requestId: nonEmpty,
      dialogType: z.string().max(1_000),
      message: browserMessage,
      defaultValue: browserMessage.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("agent.activity"),
      protocolVersion,
      seq: z.number().int().nonnegative(),
      epoch: nonEmpty,
      pageId,
      url: browserURL,
      title: browserTitle.optional(),
      kind: z.enum(["reading", "acting", "idle"]),
      tool: z.string().max(1_000),
      label: browserMessage,
    })
    .strict(),
  z
    .object({
      type: z.literal("control.changed"),
      protocolVersion,
      seq: z.number().int().nonnegative(),
      epoch: nonEmpty,
      mode: z.enum(["user", "agent"]),
    })
    .strict(),
  BrowserProtocolErrorSchema,
])
export type BrowserEvent = z.infer<typeof BrowserEventSchema>

const webRTCConnection = {
  protocolVersion,
  connectionId: nonEmpty,
  generation: z.number().int().nonnegative(),
  pageId,
}
const BrowserWebRTCOfferSchema = z
  .object({ type: z.literal("webrtc.offer"), ...webRTCConnection, sdp: z.string().min(1).max(1_000_000) })
  .strict()
const BrowserWebRTCAnswerSchema = z
  .object({ type: z.literal("webrtc.answer"), ...webRTCConnection, sdp: z.string().min(1).max(1_000_000) })
  .strict()
const BrowserWebRTCIceSchema = z
  .object({
    type: z.literal("webrtc.ice"),
    ...webRTCConnection,
    sequence: z.number().int().nonnegative(),
    candidate: z
      .object({
        candidate: z.string().max(64_000),
        sdpMid: z.string().max(1_000).nullable().optional(),
        sdpMLineIndex: z.number().int().nonnegative().max(65_535).nullable().optional(),
        usernameFragment: z.string().max(1_000).nullable().optional(),
      })
      .strict(),
  })
  .strict()
const BrowserWebRTCCloseSchema = z.object({ type: z.literal("webrtc.close"), ...webRTCConnection }).strict()
const BrowserWebRTCErrorSchema = z
  .object({ type: z.literal("webrtc.error"), ...webRTCConnection, message: browserMessage })
  .strict()

const webRTCSignalSchemas = [
  BrowserWebRTCOfferSchema,
  BrowserWebRTCAnswerSchema,
  BrowserWebRTCIceSchema,
  BrowserWebRTCCloseSchema,
  BrowserWebRTCErrorSchema,
] as const

export const BrowserWebRTCSignalSchema = z.discriminatedUnion("type", webRTCSignalSchemas)
export type BrowserWebRTCSignal = z.infer<typeof BrowserWebRTCSignalSchema>

const BrowserWebRTCViewerReadySchema = z
  .object({
    type: z.literal("webrtc.signaling.ready"),
    protocolVersion,
    presentation: BrowserPresentationSchema.nullable(),
    session: BrowserSessionStateSchema,
    pageId,
  })
  .strict()
const BrowserWebRTCHostSignalingReadySchema = BrowserWebRTCViewerReadySchema.extend({
  type: z.literal("webrtc.host.signaling.ready"),
}).strict()
const BrowserWebRTCHostReadySchema = z
  .object({ type: z.literal("webrtc.host.ready"), protocolVersion, pageId })
  .strict()
const BrowserWebRTCHostPendingSchema = z
  .object({ type: z.literal("webrtc.host.pending"), protocolVersion, pageId })
  .strict()

export const BrowserWebRTCMessageSchema = z.discriminatedUnion("type", [
  ...webRTCSignalSchemas,
  BrowserWebRTCViewerReadySchema,
  BrowserWebRTCHostSignalingReadySchema,
  BrowserWebRTCHostReadySchema,
  BrowserWebRTCHostPendingSchema,
  BrowserProtocolErrorSchema,
])
export type BrowserWebRTCMessage = z.infer<typeof BrowserWebRTCMessageSchema>

const remoteInputBase = { protocolVersion, pageId }
const remoteInputCoordinates = {
  x: z.number().min(0).max(32_768),
  y: z.number().min(0).max(32_768),
  modifiers: z.array(BrowserModifierSchema).max(5).optional(),
}
export const BrowserRemoteInputSchema = z.union([
  z
    .object({
      type: z.literal("input.mouse"),
      action: z.enum(["move", "down", "up"]),
      ...remoteInputBase,
      ...remoteInputCoordinates,
      button: z.enum(["left", "middle", "right"]).default("left"),
      clickCount: z.number().int().min(1).max(3).default(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("input.mouse"),
      action: z.literal("wheel"),
      ...remoteInputBase,
      ...remoteInputCoordinates,
      deltaX: z.number().min(-1_000_000).max(1_000_000),
      deltaY: z.number().min(-1_000_000).max(1_000_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("input.key"),
      action: z.enum(["down", "up"]),
      ...remoteInputBase,
      key: z.string().min(1).max(100),
      code: z.string().max(100).optional(),
      autoRepeat: z.boolean().optional(),
      modifiers: z.array(BrowserModifierSchema).max(5).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("input.text"),
      ...remoteInputBase,
      text: z
        .string()
        .min(1)
        .max(1_000_000)
        .refine((value) => new TextEncoder().encode(value).byteLength <= 1024 * 1024, "Remote text exceeds 1 MB."),
    })
    .strict(),
  z
    .object({
      type: z.literal("input.resize"),
      ...remoteInputBase,
      width: z.number().int().min(1).max(16_384),
      height: z.number().int().min(1).max(16_384),
    })
    .strict(),
])
export type BrowserRemoteInput = z.infer<typeof BrowserRemoteInputSchema>

export const BrowserHostMessageSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        type: z.literal("host.register"),
        protocolVersion,
        hostId: nonEmpty,
        token: BrowserRegistrationSecretSchema,
        capabilities: z.object({ native: z.boolean(), webrtc: z.boolean() }).strict(),
      })
      .strict(),
    z.object({ type: z.literal("host.registered"), protocolVersion, hostId: nonEmpty }).strict(),
    z
      .object({
        type: z.literal("page.create"),
        protocolVersion,
        requestId: nonEmpty,
        ownerKey: nonEmpty,
        owner: z
          .object({
            mode: z.enum(["session", "scope"]),
            scopeID: z.string().min(1).max(1_000),
            directory: z.string().max(20_000),
            sessionID: z.string().max(1_000).optional(),
          })
          .strict(),
        routeDirectory: nonEmpty,
        presentation: BrowserPresentationKindSchema,
        page: BrowserPageSchema,
        networkProxy: z.object({ server: nonEmpty, username: nonEmpty, password: nonEmpty }).strict(),
        downloadDir: nonEmpty,
        signalingTicket: nonEmpty.optional(),
      })
      .strict(),
    z
      .object({ type: z.literal("page.close"), protocolVersion, requestId: nonEmpty, ownerKey: nonEmpty, pageId })
      .strict(),
    z
      .object({
        type: z.literal("page.command"),
        protocolVersion,
        requestId: nonEmpty,
        ownerKey: nonEmpty,
        pageId,
        command: BrowserBackendCommandSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("page.result"),
        protocolVersion,
        requestId: nonEmpty,
        result: BrowserBackendResultSchema.optional(),
        error: BrowserProtocolErrorSchema.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("page.event"),
        protocolVersion,
        ownerKey: nonEmpty,
        pageId,
        event: BrowserHostPageEventSchema,
      })
      .strict(),
  ])
  .superRefine((message, ctx) => {
    if (message.type === "page.create") {
      const expectedOwnerKey = browserOwnerKey(message.owner)
      if (message.owner.mode === "session" && !message.owner.sessionID) {
        ctx.addIssue({
          code: "custom",
          path: ["owner", "sessionID"],
          message: "Session Browser owner requires sessionID.",
        })
      }
      if (message.owner.mode === "scope" && message.owner.sessionID !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["owner", "sessionID"],
          message: "Scope Browser owner does not accept sessionID.",
        })
      }
      if (message.ownerKey !== expectedOwnerKey) {
        ctx.addIssue({
          code: "custom",
          path: ["ownerKey"],
          message: "Browser Host ownerKey does not match owner fields.",
        })
      }
      if (message.presentation === "webrtc" && !message.signalingTicket) {
        ctx.addIssue({
          code: "custom",
          path: ["signalingTicket"],
          message: "WebRTC page creation requires a Host ticket.",
        })
      }
      if (message.presentation === "native" && message.signalingTicket !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["signalingTicket"],
          message: "Native page creation does not accept a signaling ticket.",
        })
      }
    }
    if (
      message.type === "page.result" &&
      Number(message.result !== undefined) + Number(message.error !== undefined) !== 1
    ) {
      ctx.addIssue({ code: "custom", message: "Browser Host page.result requires exactly one result or error." })
    }
  })
export type BrowserHostMessage = z.infer<typeof BrowserHostMessageSchema>

function decodedBase64Bytes(value: string): number | null {
  const normalized = value.replace(/\s/g, "")
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) return null
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0
  return Math.floor((normalized.length * 3) / 4) - padding
}
