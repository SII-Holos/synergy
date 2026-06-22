import z from "zod"

export namespace BrowserLocator {
  // Matches actual JS RegExp objects — the test suite passes live regex literals.
  const RegExpSchema = z.instanceof(RegExp)

  // A locator's primary value: either a plain string or a RegExp.
  const ValueSchema = z.union([z.string(), RegExpSchema])

  /** Zod schema for LocatorInput — discriminated on `kind`. */
  export const LocatorInputSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("ref"), value: z.string().min(1) }),
    z.object({ kind: z.literal("css"), value: z.string().min(1) }),
    z.object({
      kind: z.literal("role"),
      value: z.string().min(1),
      name: ValueSchema.optional(),
    }),
    z.object({
      kind: z.literal("text"),
      value: ValueSchema,
      exact: z.boolean().optional(),
    }),
    z.object({
      kind: z.literal("label"),
      value: ValueSchema,
      exact: z.boolean().optional(),
    }),
    z.object({
      kind: z.literal("placeholder"),
      value: ValueSchema,
      exact: z.boolean().optional(),
    }),
    z.object({ kind: z.literal("testId"), value: z.string().min(1) }),
    z.object({ kind: z.literal("xpath"), value: z.string().min(1) }),
  ])

  export type LocatorInput = z.infer<typeof LocatorInputSchema>

  /** Validate an unknown value as a LocatorInput. */
  export function validateLocator(locator: unknown): { ok: boolean; message?: string } {
    const result = LocatorInputSchema.safeParse(locator)
    if (result.success) return { ok: true }
    return { ok: false, message: result.error.message }
  }

  export interface ResolvedElement {
    visible: boolean
    enabled: boolean
    editable: boolean
    x: number
    y: number
    width: number
    height: number
  }

  export interface ActionabilityResult {
    actionable: boolean
    visible: boolean
    enabled: boolean
    editable: boolean
    failures: string[]
    bounds: { x: number; y: number; width: number; height: number }
  }

  /**
   * Check whether an element is actionable for interaction.
   *
   * - Not visible → failure
   * - Not enabled → failure
   * - Non-editable elements (e.g. `<div>`) are reported as editable:false but
   *   do NOT cause a failure on their own.
   */
  export function checkActionable(el: ResolvedElement): ActionabilityResult {
    const failures: string[] = []
    if (!el.visible) failures.push("visible")
    if (!el.enabled) failures.push("enabled")

    return {
      actionable: failures.length === 0,
      visible: el.visible,
      enabled: el.enabled,
      editable: el.editable,
      failures,
      bounds: {
        x: el.x,
        y: el.y,
        width: el.width,
        height: el.height,
      },
    }
  }
}
