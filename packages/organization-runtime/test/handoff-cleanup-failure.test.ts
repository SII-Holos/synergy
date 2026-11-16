import { expect, test } from "bun:test"
import { z } from "zod"
import { observeHandoffCleanupFailure } from "./support/handoff-cleanup-failure"

function collect(error: unknown) {
  const lines: string[] = []
  expect(observeHandoffCleanupFailure(error, "target", (line) => lines.push(line))).toBe(error)
  expect(lines).toHaveLength(1)
  const value = z
    .object({
      participant: z.literal("target"),
      facts: z.array(
        z.object({
          name: z.string(),
          code: z.string().optional(),
          relation: z.enum(["root", "cause", "errors"]),
          frames: z.array(z.object({ file: z.string(), line: z.number(), column: z.number() })),
        }),
      ),
      truncated: z.boolean().optional(),
      unavailableFields: z.number().optional(),
      repeatedReferences: z.number().optional(),
    })
    .parse(JSON.parse(lines[0].slice("EMPTY_ENVIRONMENT_HANDOFF_CLEANUP_FAILURE ".length)))
  return { value, text: lines[0] }
}

test("native Aggregate/cause descendants retain identity and only safe original owner frames", () => {
  const secret = "Bearer synthetic-secret-value https://private.invalid/secret-path"
  const leaf = Object.assign(new Error(secret), { code: "RUNTIME_OFFLINE" })
  leaf.stack = `Error: ${secret}\n at private (/private/secret-path.ts:1:2)\n at close (/runner/packages/organization-runtime/src/connection.ts:779:5)`
  const owner = new Error(secret, { cause: leaf })
  const original = new AggregateError([owner], "Synergy runtime cleanup failed")
  const { value, text } = collect(original)
  expect(value.facts.map((item) => item.relation)).toEqual(["root", "errors", "cause"])
  expect(value.facts[2].code).toBe("RUNTIME_OFFLINE")
  expect(value.facts[2].frames).toEqual([
    { file: "packages/organization-runtime/src/connection.ts", line: 779, column: 5 },
  ])
  expect(original.errors[0]).toBe(owner)
  expect(owner.cause).toBe(leaf)
  expect(text.includes("synthetic-secret-value")).toBe(false)
  expect(text.includes("private.invalid")).toBe(false)
  expect(text.includes("secret-path")).toBe(false)
})

test("accessors and descriptor/array traps cannot suppress siblings or replace the original failure", () => {
  let getters = 0
  const accessor = {}
  for (const key of ["name", "message", "stack", "data", "code", "cause", "errors"])
    Object.defineProperty(accessor, key, {
      get() {
        getters++
        throw new Error("getter invoked")
      },
    })
  const trapped = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error("descriptor rejected")
      },
    },
  )
  const revoked = Proxy.revocable([], {})
  revoked.revoke()
  const holder = Object.defineProperty({}, "errors", { value: revoked.proxy })
  const leaf = Object.assign(new Error("hidden"), { code: "RUNTIME_OFFLINE" })
  const original = new AggregateError([accessor, trapped, holder, leaf])
  const { value } = collect(original)
  expect(getters).toBe(0)
  expect((value.unavailableFields ?? 0) > 0).toBe(true)
  expect(value.facts.some((item) => item.code === "RUNTIME_OFFLINE")).toBe(true)
  expect(
    observeHandoffCleanupFailure(original, "target", () => {
      throw new Error("writer rejected")
    }),
  ).toBe(original)
})

test("cycles and wide graphs stay bounded and forged source paths cannot leak arbitrary fields", () => {
  const leaves = Array.from({ length: 64 }, () => {
    const error = new Error("Bearer synthetic-secret-value")
    error.stack = "Error: hidden\n at forged (/runner/packages/organization-runtime/src/synthetic-secret-value.ts:7:8)"
    return error
  })
  const original = new AggregateError(Array.from({ length: 8 }, () => new AggregateError(leaves)))
  Object.defineProperty(original, "cause", { value: original })
  const { value, text } = collect(original)
  expect(text.includes("synthetic-secret-value")).toBe(false)
  expect(value.facts.length <= 16).toBe(true)
  expect(value.truncated).toBe(true)
  expect(value.repeatedReferences).toBe(1)
  expect(value.facts.flatMap((item) => item.frames)).toEqual([])
  expect(text.includes("synthetic-secret-value")).toBe(false)
})
