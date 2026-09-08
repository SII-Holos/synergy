import z from "zod"

/**
 * Give a structural Zod schema an opaque domain type while retaining its
 * canonical JSON Schema representation.
 *
 * Use this for domain types such as `Scope` whose runtime representation has an
 * explicit public schema. The structural schema remains the single validation
 * and OpenAPI source; no Zod internals are patched.
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
  const schema = opts?.ref ? jsonSchema.meta({ ref: opts.ref }) : jsonSchema
  return schema as z.ZodType<T>
}
