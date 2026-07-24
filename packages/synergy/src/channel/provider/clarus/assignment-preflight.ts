import fs from "node:fs/promises"
import path from "node:path"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import z from "zod"
import type { Scope } from "@/scope"
import { isRecord } from "@/util/is-record"
import { Filesystem } from "@/util/filesystem"
import type { RuntimeTaskAssignedEvent } from "./agent-tunnel-port"
import type { ClarusCliRunner } from "./cli-runner"

const MAX_INLINE_BYTES = 2 * 1024 * 1024
const MAX_REFS = 200

export const ClarusAssignmentPreflightError = NamedError.create(
  "ClarusAssignmentPreflightError",
  z.object({ missingInputs: z.array(z.string()) }),
)

type ResolvedInput = { ref: string; relativePath: string }
type Manifest = { runID: string; inputs: ResolvedInput[] }
type FileCandidate = { id: string; names: string[] }

function hash(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

function safeFilename(value: string, fallback: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
  return (normalized || fallback).slice(0, 120)
}

function collectInputRefs(value: unknown, refs = new Set<string>(), depth = 0): Set<string> {
  if (depth > 16 || refs.size >= MAX_REFS) return refs
  if (Array.isArray(value)) {
    for (const item of value) collectInputRefs(item, refs, depth + 1)
    return refs
  }
  if (!isRecord(value)) return refs
  for (const [key, nested] of Object.entries(value)) {
    if (key === "input_refs" || key === "inputRefs") {
      if (Array.isArray(nested)) {
        for (const item of nested) {
          if (typeof item === "string" && item.trim()) refs.add(item.trim())
          else if (isRecord(item)) {
            const name = item.name ?? item.artifact_id ?? item.artifactId ?? item.ref
            if (typeof name === "string" && name.trim()) refs.add(name.trim())
          }
        }
      }
      continue
    }
    collectInputRefs(nested, refs, depth + 1)
  }
  return refs
}

function textParts(value: unknown): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.parts)) return undefined
  const parts = value.parts.flatMap((part) => {
    if (!isRecord(part) || typeof part.content !== "string" || !part.content.trim()) return []
    return [part.content]
  })
  const text = parts.join("\n\n").trim()
  return text || undefined
}

function candidateNames(value: Record<string, unknown>): string[] {
  return [value.name, value.path, value.artifact_id, value.artifactId, value.file_id, value.fileId]
    .filter((item): item is string => typeof item === "string" && item.length > 0)
    .map((item) => item.toLowerCase())
}

function matches(ref: string, names: string[]): boolean {
  const target = ref.toLowerCase()
  return names.some(
    (name) => name === target || path.basename(name) === target || path.parse(path.basename(name)).name === target,
  )
}

function findInline(value: unknown, ref: string, depth = 0): string | undefined {
  if (depth > 20) return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findInline(item, ref, depth + 1)
      if (found) return found
    }
    return undefined
  }
  if (!isRecord(value)) return undefined
  if (matches(ref, candidateNames(value))) {
    const direct = typeof value.content === "string" && value.content.trim() ? value.content : textParts(value)
    if (direct) return direct
  }
  for (const nested of Object.values(value)) {
    const found = findInline(nested, ref, depth + 1)
    if (found) return found
  }
  return undefined
}

function collectFiles(value: unknown, files: FileCandidate[] = [], depth = 0): FileCandidate[] {
  if (depth > 20) return files
  if (Array.isArray(value)) {
    for (const item of value) collectFiles(item, files, depth + 1)
    return files
  }
  if (!isRecord(value)) return files
  const id = value.file_id ?? value.fileId
  if (typeof id === "string" && id) files.push({ id, names: candidateNames(value) })
  for (const nested of Object.values(value)) collectFiles(nested, files, depth + 1)
  return files
}

async function readManifest(file: string, runID: string): Promise<Manifest | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Manifest
    if (parsed.runID !== runID || !Array.isArray(parsed.inputs)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

async function validateCachedInputs(scopeDirectory: string, refs: string[], inputs: ResolvedInput[]): Promise<boolean> {
  if (inputs.length !== refs.length || inputs.some((item, index) => item.ref !== refs[index])) return false
  const realScope = await fs.realpath(scopeDirectory)
  const stats = await Promise.all(
    inputs.map(async (item) => {
      const target = path.resolve(scopeDirectory, item.relativePath)
      if (!Filesystem.contains(scopeDirectory, target)) return null
      const realTarget = await fs.realpath(target).catch(() => undefined)
      if (!realTarget || !Filesystem.contains(realScope, realTarget)) return null
      return fs.stat(realTarget).catch(() => null)
    }),
  )
  return stats.every((item) => item?.isFile() && item.size > 0)
}

export type ClarusAssignmentPreflightResult = { inputs: ResolvedInput[]; promptSection: string }

export function clarusAssignmentInputRefs(event: RuntimeTaskAssignedEvent): string[] {
  return [...collectInputRefs([event.input, event.context, event.taskInput])]
}

export async function preflightClarusAssignment(input: {
  event: RuntimeTaskAssignedEvent
  scope: Scope.Project
  runner?: ClarusCliRunner
}): Promise<ClarusAssignmentPreflightResult> {
  const refs = clarusAssignmentInputRefs(input.event)
  if (refs.length === 0) return { inputs: [], promptSection: "" }
  if (!input.runner) throw new ClarusAssignmentPreflightError({ missingInputs: refs })

  const runDirectory = path.join(input.scope.directory, ".clarus", "inputs", hash(input.event.runID).slice(0, 24))
  const manifestFile = path.join(runDirectory, "manifest.json")
  const cached = await readManifest(manifestFile, input.event.runID)
  if (cached && (await validateCachedInputs(input.scope.directory, refs, cached.inputs))) {
    return { inputs: cached.inputs, promptSection: renderPrompt(cached.inputs) }
  }

  const [context, run, phaseStates] = await Promise.all([
    input.runner.json(["runtime", "context", input.event.projectID, "--latest", "--include-events"]),
    input.runner.json(["runtime", "info", input.event.runID]),
    input.runner.json(["runtime", "phase-states", input.event.runID, "--phase", input.event.phase, "--latest"]),
  ])
  const sources = [context, run, phaseStates]
  const files = collectFiles(sources)
  const resolved: ResolvedInput[] = []
  const missing: string[] = []
  await fs.rm(runDirectory, { recursive: true, force: true })
  await fs.mkdir(runDirectory, { recursive: true, mode: 0o700 })

  for (const [index, ref] of refs.entries()) {
    const filename = `${String(index + 1).padStart(3, "0")}-${safeFilename(ref, `input-${index + 1}`)}`
    const target = path.join(runDirectory, filename)
    const inline = findInline(sources, ref)
    if (inline) {
      const bytes = new TextEncoder().encode(inline)
      if (bytes.byteLength > MAX_INLINE_BYTES) throw new ClarusAssignmentPreflightError({ missingInputs: [ref] })
      await fs.writeFile(target, inline, { mode: 0o600 })
    } else {
      const file = files.find((candidate) => matches(ref, candidate.names))
      if (!file) {
        missing.push(ref)
        continue
      }
      try {
        const preview = await input.runner.json(["file", "preview", input.event.projectID, file.id])
        const content = isRecord(preview) && typeof preview.content === "string" ? preview.content : undefined
        if (!content) throw new Error("Preview did not include text content")
        await fs.writeFile(target, content, { mode: 0o600 })
      } catch {
        try {
          await input.runner.download(["file", "download", input.event.projectID, file.id], target)
        } catch {
          missing.push(ref)
          continue
        }
      }
    }
    const relativePath = path.relative(input.scope.directory, target)
    resolved.push({ ref, relativePath })
  }

  if (missing.length > 0) {
    await fs.rm(runDirectory, { recursive: true, force: true })
    throw new ClarusAssignmentPreflightError({ missingInputs: missing })
  }
  const manifest: Manifest = { runID: input.event.runID, inputs: resolved }
  await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  return { inputs: resolved, promptSection: renderPrompt(resolved) }
}

function renderPrompt(inputs: ResolvedInput[]): string {
  if (inputs.length === 0) return ""
  return [
    "## Resolved upstream inputs",
    "",
    "Read these workspace-relative files before producing the task result:",
    ...inputs.map((item) => `- ${item.ref}: \`${item.relativePath}\``),
  ].join("\n")
}
