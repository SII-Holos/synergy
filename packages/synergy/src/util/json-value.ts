import z from "zod"

const json = z.json()

// hono-openapi 1.1.2 loses nested recursive $defs. JSON payloads need no recursive
// OpenAPI restriction, but persistence still validates every nested value.
export const JsonValue = z
  .unknown()
  .refine((value) => json.safeParse(value).success, "Expected a JSON value") as z.ZodType<z.infer<typeof json>>
