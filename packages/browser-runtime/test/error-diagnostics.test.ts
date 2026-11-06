import { expect, test } from "bun:test"
import { z } from "zod"
import { browserErrorDiagnostics } from "../src/error-diagnostics"

test("schema diagnostics retain known field paths and codes without input or unknown keys", () => {
  const schema = z.object({ pages: z.array(z.object({ error: z.object({ message: z.string().min(1) }) })) })
  const parsed = schema.safeParse({ pages: [{ error: { message: "" } }] })
  expect(parsed.success).toBe(false)
  if (parsed.success) return
  expect(browserErrorDiagnostics(parsed.error)).toEqual({
    errorKind: "schema_validation",
    issueCount: 1,
    issues: [{ code: "too_small", path: ["pages", 0, "error", "message"] }],
  })
  const untrusted = z.record(z.string(), z.number()).safeParse({ "/private/account token=fixture-secret": "secret" })
  if (untrusted.success) throw new Error("Expected invalid fixture")
  expect(browserErrorDiagnostics(untrusted.error)).toMatchObject({
    issues: [{ code: "invalid_type", path: ["*"] }],
  })
  expect(JSON.stringify(browserErrorDiagnostics(untrusted.error))).not.toMatch(/private|secret/)
})

test("diagnostics classify errors without exposing arbitrary messages, names or codes", () => {
  const error = Object.assign(new TypeError("/private/account token=fixture-secret"), {
    name: "private-name",
    code: "private-code",
  })
  expect(browserErrorDiagnostics(error)).toEqual({ errorKind: "type_error" })
  expect(browserErrorDiagnostics(Object.assign(error, { code: "EACCES" }))).toEqual({
    errorKind: "system_error",
    code: "EACCES",
  })
  expect(browserErrorDiagnostics("fixture-secret")).toEqual({ errorKind: "non_error" })
})

test("schema diagnostics bound issue counts and path depth", () => {
  const invalid = z.array(z.string()).safeParse(Array.from({ length: 20 }, () => null))
  if (invalid.success) throw new Error("Expected invalid fixture")
  const diagnostics = browserErrorDiagnostics(invalid.error)
  expect(diagnostics.issueCount).toBe(20)
  expect(diagnostics.issues).toHaveLength(8)
})
