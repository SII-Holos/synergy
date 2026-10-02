import type { JSONSchema7 } from "ai"

export namespace ToolIntent {
  export const description = "One short sentence stating this action’s purpose and target, in the task’s language."
  export const guidance =
    "For tool calls, use workBrief to state the action’s purpose and target in the task’s language, using known context. Report outcomes after receiving the tool result."
  export type Shape = "flat" | "envelope"
  export interface Binding {
    schema: JSONSchema7
    nativeSchema: JSONSchema7
    inputShape: Shape
  }

  function freeze<T>(value: T): T {
    if (value && typeof value === "object") {
      Object.values(value).forEach(freeze)
      Object.freeze(value)
    }
    return value
  }

  function rebase(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(rebase)
    if (!value || typeof value !== "object") return value
    const object = value as Record<string, unknown>
    if (typeof object.$id === "string") return structuredClone(object)
    return Object.fromEntries(
      Object.entries(object).map(([key, child]) => [
        key,
        key === "$ref" && typeof child === "string" && (child === "#" || child.startsWith("#/"))
          ? `#/$defs/toolInput${child.slice(1)}`
          : rebase(child),
      ]),
    )
  }

  function referencesRoot(value: unknown, root = true): boolean {
    if (!value || typeof value !== "object") return false
    if (Array.isArray(value)) return value.some((child) => referencesRoot(child, false))
    const object = value as Record<string, unknown>
    if (!root && typeof object.$id === "string") return false
    return object.$ref === "#" || Object.values(object).some((child) => referencesRoot(child, false))
  }

  export function snapshot(source: JSONSchema7): Binding {
    const native = structuredClone(source)
    const flat =
      native.type === "object" &&
      !referencesRoot(native) &&
      !Object.hasOwn(native.properties ?? {}, "workBrief") &&
      ![
        "$ref",
        "allOf",
        "oneOf",
        "anyOf",
        "not",
        "if",
        "patternProperties",
        "propertyNames",
        "dependentSchemas",
        "dependencies",
        "minProperties",
        "maxProperties",
        "unevaluatedProperties",
      ].some((key) => Object.hasOwn(native, key))
    const brief = { type: "string" as const, description }
    const schema: JSONSchema7 = flat
      ? { ...native, properties: { ...native.properties, workBrief: brief } }
      : ({
          type: "object",
          properties: { workBrief: brief, toolInput: { $ref: "#/$defs/toolInput" } },
          required: ["toolInput"],
          additionalProperties: false,
          $defs: { toolInput: rebase(native) },
        } as JSONSchema7)
    return freeze({ schema, nativeSchema: native, inputShape: flat ? "flat" : "envelope" })
  }

  export function decode(
    binding: Binding,
    value: Record<string, unknown>,
  ): { input: unknown; workBrief?: string; inputShape: Shape } {
    const workBrief = typeof value.workBrief === "string" ? value.workBrief.trim() || undefined : undefined
    const { workBrief: _brief, ...input } = value
    return {
      input: binding.inputShape === "envelope" ? value.toolInput : input,
      workBrief,
      inputShape: binding.inputShape,
    }
  }

  export function encode(input: unknown, workBrief?: string, inputShape: Shape = "flat"): Record<string, unknown> {
    const brief = workBrief ? { workBrief } : {}
    if (inputShape === "envelope") return { ...brief, toolInput: input }
    return { ...(input as Record<string, unknown>), ...brief }
  }
}
