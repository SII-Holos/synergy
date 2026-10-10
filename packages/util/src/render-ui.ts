import { z } from "zod"

export namespace RenderUI {
  export const Key = z
    .string()
    .regex(/^[a-zA-Z][\w-]{0,63}$/)
    .refine((key) => !["constructor", "prototype", "__proto__"].includes(key))
  export const Value = z.union([z.string().max(2000), z.number().finite(), z.boolean()])
  export type Value = z.infer<typeof Value>
  export const Binding = z.union([Value, z.object({ ref: Key }).strict()])
  export type Binding = z.infer<typeof Binding>
  const base = { id: Key, parent: Key.optional() }
  const text = z.string().max(4000)
  export const Node = z.discriminatedUnion("type", [
    z.object({ ...base, type: z.literal("heading"), text, level: z.enum(["2", "3"]).optional() }).strict(),
    z.object({ ...base, type: z.literal("text"), text }).strict(),
    z.object({ ...base, type: z.literal("row"), columns: z.number().int().min(1).max(4).optional() }).strict(),
    z.object({ ...base, type: z.literal("card"), title: text.optional() }).strict(),
    z
      .object({
        ...base,
        type: z.literal("metric"),
        label: text,
        value: Binding,
        prefix: z.string().max(40).optional(),
        suffix: z.string().max(40).optional(),
      })
      .strict(),
    z
      .object({
        ...base,
        type: z.literal("slider"),
        label: text,
        state: Key,
        min: z.number().finite(),
        max: z.number().finite(),
        step: z.number().positive().optional(),
      })
      .strict(),
    z
      .object({
        ...base,
        type: z.literal("select"),
        label: text,
        state: Key,
        options: z.array(z.string().max(200)).min(1).max(24),
      })
      .strict(),
    z.object({ ...base, type: z.literal("checkbox"), label: text, state: Key }).strict(),
    z.object({ ...base, type: z.literal("button"), label: text, text: z.string().min(1).max(4000) }).strict(),
    z
      .object({
        ...base,
        type: z.literal("bar"),
        label: text,
        items: z
          .array(z.object({ label: text, value: Binding }).strict())
          .min(1)
          .max(32),
      })
      .strict(),
  ])
  export type Node = z.infer<typeof Node>
  export const Computed = z
    .object({
      id: Key,
      op: z.enum(["add", "subtract", "multiply", "divide", "min", "max"]),
      inputs: z.tuple([Binding, Binding]),
    })
    .strict()
  export const Spec = z
    .object({
      state: z.record(Key, Value).default({}),
      computed: z.array(Computed).max(64).default([]),
      nodes: z.array(Node).min(1).max(128),
    })
    .strict()
    .superRefine((spec, ctx) => {
      if (new TextEncoder().encode(JSON.stringify(spec)).byteLength > 128 * 1024)
        ctx.addIssue({ code: "custom", message: "UI exceeds 128 KiB" })
      if (new TextEncoder().encode(JSON.stringify(spec.state)).byteLength > 12 * 1024)
        ctx.addIssue({ code: "custom", message: "Initial state exceeds 12 KiB" })
      const values = new Set(Object.keys(spec.state))
      if (values.size > 32) ctx.addIssue({ code: "custom", message: "At most 32 state values" })
      function binding(value: Binding) {
        if (typeof value === "object" && !values.has(value.ref))
          ctx.addIssue({ code: "custom", message: `Unknown value: ${value.ref}` })
      }
      for (const computed of spec.computed) {
        if (values.has(computed.id)) ctx.addIssue({ code: "custom", message: `Duplicate value: ${computed.id}` })
        computed.inputs.forEach(binding)
        values.add(computed.id)
      }
      const nodes = new Map<string, Node>()
      for (const node of spec.nodes) {
        if (nodes.has(node.id)) ctx.addIssue({ code: "custom", message: `Duplicate node: ${node.id}` })
        if (node.parent) {
          const parent = nodes.get(node.parent)
          if (!parent || !["row", "card"].includes(parent.type))
            ctx.addIssue({ code: "custom", message: `Parent must be an earlier row or card: ${node.id}` })
        }
        if ("state" in node) {
          const value = spec.state[node.state]
          if (
            value === undefined ||
            (node.type === "slider" &&
              (typeof value !== "number" || node.min >= node.max || value < node.min || value > node.max)) ||
            (node.type === "checkbox" && typeof value !== "boolean") ||
            (node.type === "select" && (typeof value !== "string" || !node.options.includes(value)))
          )
            ctx.addIssue({ code: "custom", message: `Invalid control state: ${node.id}` })
        }
        if (node.type === "metric") binding(node.value)
        if (node.type === "bar") node.items.forEach((item) => binding(item.value))
        nodes.set(node.id, node)
      }
    })
    .meta({ ref: "RenderUI" })
  export type Spec = z.infer<typeof Spec>

  /**
   * Provenance: https://www.openui.com/blog/how-chatgpt-intelligent-ui-works
   * Local adaptation: bounded declarative data, keyed controls and local arithmetic replace authored programs.
   */
  export function evaluate(spec: Spec, state: Record<string, Value>): Record<string, Value> {
    const values = Object.assign(Object.create(null), spec.state, state) as Record<string, Value>
    function resolve(value: Binding) {
      return typeof value === "object" ? values[value.ref] : value
    }
    for (const item of spec.computed) {
      const a = resolve(item.inputs[0]),
        b = resolve(item.inputs[1])
      if (typeof a !== "number" || typeof b !== "number") throw new Error(`Invalid numeric inputs: ${item.id}`)
      const result =
        item.op === "add"
          ? a + b
          : item.op === "subtract"
            ? a - b
            : item.op === "multiply"
              ? a * b
              : item.op === "divide"
                ? a / b
                : item.op === "min"
                  ? Math.min(a, b)
                  : Math.max(a, b)
      if (!Number.isFinite(result)) throw new Error(`Invalid arithmetic result: ${item.id}`)
      values[item.id] = result
    }
    return values
  }

  export function preview(input: unknown): Spec | undefined {
    if (!input || typeof input !== "object") return
    const raw = input as Record<string, unknown>
    if (raw.state !== undefined && (!raw.state || typeof raw.state !== "object" || Array.isArray(raw.state))) return
    const state = z.record(Key, Value).safeParse(Object.fromEntries(Object.entries(raw.state ?? {})))
    if (!state.success || Object.keys(state.data).length > 32 || !Array.isArray(raw.nodes) || raw.nodes.length > 128)
      return
    const computed: z.infer<typeof Computed>[] = []
    if (Array.isArray(raw.computed)) {
      if (raw.computed.length > 64) return
      for (const value of raw.computed) {
        const parsed = Computed.safeParse(value)
        if (!parsed.success) break
        computed.push(parsed.data)
      }
    }
    const nodes: Node[] = []
    for (const value of raw.nodes) {
      const parsed = Node.safeParse(value)
      if (!parsed.success) break
      nodes.push(parsed.data)
    }
    const parsed = Spec.safeParse({ state: state.data, computed, nodes })
    return parsed.success ? parsed.data : undefined
  }

  export function fallback(spec: Spec) {
    const values = evaluate(spec, spec.state)
    const escape = (text: unknown) =>
      String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
    const resolve = (value: Binding) => (typeof value === "object" ? values[value.ref] : value)
    return spec.nodes
      .map((node) => {
        if (node.type === "heading") return `<h${node.level ?? "2"}>${escape(node.text)}</h${node.level ?? "2"}>`
        if (node.type === "text") return `<p>${escape(node.text)}</p>`
        if (node.type === "metric")
          return `<p>${escape(node.label)}: ${escape(node.prefix ?? "")}${escape(resolve(node.value))}${escape(node.suffix ?? "")}</p>`
        if (node.type === "bar")
          return `<p>${escape(node.label)}</p><ul>${node.items.map((item) => `<li>${escape(item.label)}: ${escape(resolve(item.value))}</li>`).join("")}</ul>`
        if ("state" in node) return `<p>${escape(node.label)}: ${escape(spec.state[node.state])}</p>`
        if (node.type === "card" && node.title) return `<h3>${escape(node.title)}</h3>`
        return ""
      })
      .join("\n")
  }
}
