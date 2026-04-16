import z from "zod"

/**
 * Create a `z.custom<T>()` schema that is safe for OpenAPI / JSON Schema generation.
 *
 * Raw `z.custom<T>()` schemas throw "Custom types cannot be represented in JSON Schema"
 * when processed by `z.toJSONSchema()` (used by hono-openapi's `resolver()`). This
 * helper attaches a `_zod.toJSONSchema` override so the schema serializes correctly.
 *
 * Use this for any opaque runtime type (e.g. `Scope`) that needs to appear in
 * API-facing Zod schemas. The `jsonSchema` argument defines what the type looks like
 * in the generated OpenAPI spec.
 *
 * @example
 * ```ts
 * const ScopeField = opaque<Scope>(
 *   z.object({ id: z.string(), directory: z.string().optional() }),
 *   { ref: "SessionScope" },
 * )
 * ```
 */
export function opaque<T>(jsonSchema: z.ZodType, opts?: { ref?: string }): z.ZodType<T> {
  const schema = z.custom<T>(() => true)
  const withMeta = opts?.ref ? schema.meta({ ref: opts.ref }) : schema
  withMeta._zod.toJSONSchema = () => z.toJSONSchema(jsonSchema)
  return withMeta
}
