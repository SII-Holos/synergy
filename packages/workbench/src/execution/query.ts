import { z } from "zod"

export class ExecutionQueryError extends RangeError {}

export function queryValue<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new ExecutionQueryError("Invalid execution query")
  return parsed.data
}

export function queryCursor<T extends z.ZodType>(schema: T, cursor: string): z.infer<T> {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString())
  } catch {
    throw new ExecutionQueryError("Invalid execution cursor")
  }
  return queryValue(schema, value)
}
