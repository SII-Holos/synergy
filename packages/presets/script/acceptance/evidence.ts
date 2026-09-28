import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const name = z.string().regex(/^[a-z][a-z0-9-]*$/)
export const EvidenceKind = z.enum(["product", "external", "transport"])
export const Oracle = z
  .object({
    evidence: z.string().min(1),
    pointer: z.array(z.union([z.string(), z.number().int().nonnegative()])).optional(),
    equals: z.json().optional(),
    minimum: z.number().optional(),
    sha256: hash.optional(),
  })
  .strict()
  .refine((value) => value.equals !== undefined || value.minimum !== undefined || value.sha256 !== undefined)

export const AcceptanceCase = z
  .object({
    id: name,
    units: z.array(z.enum(["A", "B", "C", "D", "E", "F"])).min(1),
    risk: z.string().min(1),
    preconditions: z.array(z.string().min(1)).min(1),
    actions: z.array(z.string().min(1)).min(1),
    fault: z.string().min(1),
    expected: z.array(z.string().min(1)).min(1),
    verification: z.string().min(1),
    live: z.boolean(),
    agent: z.enum(["synergy", "synergy-max", "synergy-flash"]).optional(),
    barriers: z.array(name).min(1),
    factors: z.array(z.string().min(1)).min(2),
    checks: z.array(Oracle).min(1),
  })
  .strict()
export type AcceptanceCase = z.infer<typeof AcceptanceCase>

export const Evidence = z
  .object({
    path: z.string().min(1),
    kind: EvidenceKind,
    sha256: hash,
    bytes: z.number().int().nonnegative(),
  })
  .strict()
export type Evidence = z.infer<typeof Evidence>

export const ModelRequest = z
  .object({
    id: z.string().min(1),
    status: z.enum(["completed", "failed", "cancelled", "unknown"]),
    provider: z.string().optional(),
    model: z.string().optional(),
    usage: z
      .object({ input: z.number().nonnegative().nullable(), output: z.number().nonnegative().nullable() })
      .strict()
      .nullable(),
  })
  .strict()
export type ModelRequest = z.infer<typeof ModelRequest>

export const Result = z
  .object({
    version: z.literal(1),
    plan: hash,
    source: z.string().regex(/^[a-f0-9]{40}$/),
    case: name,
    attempt: z.number().int().positive(),
    started: z.number().nonnegative(),
    finished: z.number().nonnegative(),
    status: z.enum(["passed", "failed", "unknown", "uncovered"]),
    model: z.enum(["passed", "failed", "unknown", "not-applicable"]),
    barriers: z.array(name),
    evidence: z.array(Evidence),
    requests: z.array(ModelRequest),
    reason: z.string().optional(),
  })
  .strict()
export type Result = z.infer<typeof Result>

export function digest(bytes: string | Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}

export async function evidencePath(root: string, file: string) {
  if (path.isAbsolute(file) || file.split(/[\\/]/).some((part) => !part || part === "." || part === ".."))
    throw new Error("Evidence path must be relative and contained")
  const directory = await fs.realpath(root)
  const target = path.join(directory, file)
  if ((await fs.realpath(target)) !== target || !(await fs.lstat(target)).isFile())
    throw new Error("Evidence must be an ordinary contained file")
  return target
}

export async function sealEvidence(root: string, file: string, kind: Evidence["kind"]): Promise<Evidence> {
  const bytes = new Uint8Array(await Bun.file(await evidencePath(root, file)).arrayBuffer())
  return { path: file, kind, sha256: digest(bytes), bytes: bytes.byteLength }
}

export async function verifyResult(
  root: string,
  scenario: AcceptanceCase,
  input: unknown,
  identity: { plan: string; source: string },
) {
  const parsed = Result.safeParse(input)
  if (!parsed.success) return ["malformed-result"]
  const result = parsed.data
  const errors: string[] = []
  if (result.plan !== identity.plan) errors.push("plan")
  if (result.source !== identity.source) errors.push("source")
  if (result.case !== scenario.id) errors.push("case")
  if (result.finished < result.started) errors.push("clock")
  if (result.status !== "passed") errors.push(`status:${result.status}`)
  if (scenario.live && result.model !== "passed") errors.push(`model:${result.model}`)
  if (scenario.live && !result.requests.length) errors.push("uncovered:real-model")
  if (new Set(result.requests.map((request) => request.id)).size !== result.requests.length)
    errors.push("duplicate-request")
  for (const barrier of scenario.barriers) if (!result.barriers.includes(barrier)) errors.push(`untriggered:${barrier}`)
  for (const kind of EvidenceKind.options)
    if (!result.evidence.some((entry) => entry.kind === kind)) errors.push(`missing-kind:${kind}`)
  if (new Set(result.evidence.map((entry) => entry.path)).size !== result.evidence.length)
    errors.push("duplicate-evidence")
  const observed = new Map<string, Uint8Array>()
  for (const evidence of result.evidence) {
    try {
      const bytes = new Uint8Array(await Bun.file(await evidencePath(root, evidence.path)).arrayBuffer())
      if (digest(bytes) !== evidence.sha256 || bytes.byteLength !== evidence.bytes)
        errors.push(`changed:${evidence.path}`)
      else observed.set(evidence.path, bytes)
    } catch {
      errors.push(`missing:${evidence.path}`)
    }
  }
  for (const check of scenario.checks) {
    const bytes = observed.get(check.evidence)
    if (!bytes) {
      errors.push(`oracle:${check.evidence}:missing`)
      continue
    }
    if (check.sha256 !== undefined && digest(bytes) !== check.sha256) errors.push(`oracle:${check.evidence}:sha256`)
    if (check.equals === undefined && check.minimum === undefined) continue
    try {
      let value: unknown = JSON.parse(new TextDecoder().decode(bytes))
      for (const key of check.pointer ?? []) {
        if (typeof value !== "object" || value === null || !(key in value)) throw new Error("Missing observation")
        value = (value as Record<string | number, unknown>)[key]
      }
      if (check.equals !== undefined && !isDeepStrictEqual(value, check.equals))
        errors.push(`oracle:${check.evidence}:${(check.pointer ?? []).join(".")}`)
      if (check.minimum !== undefined && (typeof value !== "number" || value < check.minimum))
        errors.push(`oracle:${check.evidence}:minimum`)
    } catch {
      errors.push(`oracle:${check.evidence}:json`)
    }
  }
  return errors
}

export async function atomicJSON(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const staging = `${file}.${crypto.randomUUID()}.tmp`
  const handle = await fs.open(staging, "wx", 0o600)
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n")
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(staging, file)
  const parent = await fs.open(path.dirname(file), "r")
  try {
    await parent.sync()
  } finally {
    await parent.close()
  }
}
