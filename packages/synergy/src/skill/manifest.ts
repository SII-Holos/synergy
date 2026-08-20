import path from "path"
import { z } from "zod"
import { ConfigMarkdown } from "../config/markdown"
import type { SkillSourceProfile } from "./source-profile"

export namespace SkillManifest {
  const name = z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Must contain lowercase letters, digits, and single hyphens only")

  export const Schema = z
    .object({
      name,
      description: z.string().min(1).max(1024),
      license: z.string().optional(),
      compatibility: z.string().max(500).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
      "allowed-tools": z.union([z.string(), z.array(z.string())]).optional(),
      "user-invocable": z.boolean().default(true),
      "disable-model-invocation": z.boolean().default(false),
    })
    .strict()

  export type Parsed = z.infer<typeof Schema>

  const ProgrammaticSchema = Schema.extend({
    name: z.string().min(1),
    description: z.string().min(1),
  })

  export const Diagnostic = z.object({
    code: z.string(),
    severity: z.enum(["error", "warning", "info"]),
    name: z.string(),
    source: z.enum(["builtin", "plugin", "synergy", "agents", "claude", "codex", "openclaw"]),
    path: z.string().optional(),
    field: z.string().optional(),
    reason: z.record(z.string(), z.unknown()),
    message: z.string(),
  })
  export type Diagnostic = z.infer<typeof Diagnostic>

  export type Normalized = {
    name: string
    description: string
    declaredLicense?: string
    declaredCompatibility?: string
    invocation: { user: boolean; model: boolean }
    content: string
    diagnostics: Diagnostic[]
  }

  const knownFields = new Set(Object.keys(Schema.shape))

  function describeInput(input: unknown): string {
    if (Array.isArray(input)) return "array"
    if (input === null) return "null"
    return typeof input
  }

  function issueMessage(issue: z.core.$ZodIssue): string {
    const field = issue.path.length > 0 ? `'${issue.path.join(".")}'` : "manifest"
    switch (issue.code) {
      case "invalid_type":
        return `Invalid field ${field}: expected ${issue.expected}, received ${describeInput(issue.input)}`
      case "invalid_union": {
        const expected = new Set<string>()
        for (const branch of issue.errors) {
          const firstType = branch.find((sub) => sub.code === "invalid_type")
          if (firstType && firstType.code === "invalid_type") expected.add(String(firstType.expected))
        }
        const expectation = expected.size > 0 ? [...expected].join(" or ") : "a valid value"
        return `Invalid field ${field}: expected ${expectation}, received ${describeInput(issue.input)}`
      }
      case "unrecognized_keys":
        return `Invalid field ${field}: unknown field(s) ${issue.keys.map((key) => `'${key}'`).join(", ")}`
      default:
        return `Invalid field ${field}: ${issue.message}`
    }
  }

  function issueReason(issue: z.core.$ZodIssue): Record<string, unknown> {
    switch (issue.code) {
      case "invalid_type":
        return { kind: issue.code, expected: issue.expected, received: describeInput(issue.input) }
      case "unrecognized_keys":
        return { kind: issue.code, keys: issue.keys }
      default:
        return { kind: issue.code }
    }
  }

  type FrontmatterMark = { position?: number; line?: number; column?: number; buffer?: string }

  // js-yaml reports an unquoted plain scalar containing ': ' as one of these
  // errors; other syntax failures (bad indentation, unterminated flow
  // collections, ...) must not get a quoting hint that does not apply.
  const UNQUOTED_COLON_DETAIL_PATTERNS = [/incomplete explicit mapping pair/, /mapping values are not allowed/]

  function frontmatterErrorDetails(error: unknown): {
    field?: string
    line?: number
    column?: number
    position?: number
    detail?: string
    quotingTip?: boolean
  } {
    const cause = error instanceof Error && error.cause ? error.cause : error
    const mark = (cause as { mark?: FrontmatterMark } | undefined)?.mark
    if (!mark || typeof mark.position !== "number" || typeof mark.buffer !== "string") return {}
    // Include the character at the mark: for "bad indentation" errors the
    // position points at the key's colon, which would otherwise be cut off
    // and the nearest field lookup would fall back to the previous key.
    const before = mark.buffer.slice(0, mark.position + 1)
    const keys = [...before.matchAll(/^\s*([A-Za-z0-9_-]+):/gm)]
    const field = keys.length > 0 ? keys[keys.length - 1]![1] : undefined
    const detail = cause instanceof Error ? cause.message.split("\n")[0] : undefined
    // js-yaml marks are zero-based; expose one-based line/column so the
    // structured reason matches the "at line N, column M" text in the message.
    const line = typeof mark.line === "number" ? mark.line + 1 : undefined
    const column = typeof mark.column === "number" ? mark.column + 1 : undefined
    return {
      field,
      line,
      column,
      position: mark.position,
      detail,
      quotingTip: detail !== undefined && UNQUOTED_COLON_DETAIL_PATTERNS.some((pattern) => pattern.test(detail)),
    }
  }

  function issuesToDiagnostics(
    issues: z.core.$ZodIssue[],
    input: { name: string; source: SkillSourceProfile.SourceID; entryFile: string; severity: "error" | "warning" },
  ) {
    return issues.map(
      (issue): Diagnostic => ({
        code: "skill.manifest_invalid",
        severity: input.severity,
        name: input.name,
        source: input.source,
        path: input.entryFile,
        field: issue.path.length > 0 ? issue.path.join(".") : undefined,
        reason: issueReason(issue),
        message: issueMessage(issue),
      }),
    )
  }

  export function validateDirectory(entryFile: string, manifest: Parsed) {
    const diagnostics: Diagnostic[] = []
    if (path.basename(entryFile) !== "SKILL.md") {
      diagnostics.push({
        code: "skill.entry_name_invalid",
        severity: "error",
        name: manifest.name,
        source: "synergy",
        path: entryFile,
        reason: { expected: "SKILL.md", actual: path.basename(entryFile) },
        message: "Strict Skills must use the exact entry name SKILL.md",
      })
    }
    const directoryName = path.basename(path.dirname(entryFile))
    if (directoryName !== manifest.name) {
      diagnostics.push({
        code: "skill.directory_name_mismatch",
        severity: "error",
        name: manifest.name,
        source: "synergy",
        path: entryFile,
        field: "name",
        reason: { expected: directoryName, actual: manifest.name },
        message: `Skill name '${manifest.name}' must match directory '${directoryName}'`,
      })
    }
    return diagnostics
  }

  export function normalizeProgrammatic(input: {
    manifest: {
      name: string
      description: string
      license?: string
      compatibility?: string
      userInvocable?: boolean
      disableModelInvocation?: boolean
    }
    source: "builtin" | "plugin"
  }): { value?: Omit<Normalized, "content">; diagnostics: Diagnostic[] } {
    const result = (input.source === "plugin" ? ProgrammaticSchema : Schema).safeParse({
      name: input.manifest.name,
      description: input.manifest.description,
      license: input.manifest.license,
      compatibility: input.manifest.compatibility,
      "user-invocable": input.manifest.userInvocable,
      "disable-model-invocation": input.manifest.disableModelInvocation,
    })
    if (!result.success) {
      const diagnostics = result.error.issues.map(
        (issue): Diagnostic => ({
          code: "skill.manifest_invalid",
          severity: "error",
          name: input.manifest.name,
          source: input.source,
          field: issue.path.length > 0 ? issue.path.join(".") : undefined,
          reason: issueReason(issue),
          message: issueMessage(issue),
        }),
      )
      return { diagnostics }
    }
    const value = normalized(result.data, "", [])
    return {
      value: {
        name: value.name,
        description: value.description,
        declaredLicense: value.declaredLicense,
        declaredCompatibility: value.declaredCompatibility,
        invocation: value.invocation,
        diagnostics: [],
      },
      diagnostics: [],
    }
  }

  export async function normalizeFile(input: {
    entryFile: string
    source: SkillSourceProfile.SourceID
    mode: SkillSourceProfile.ValidationMode
  }): Promise<{ value?: Normalized; diagnostics: Diagnostic[] }> {
    let document: Awaited<ReturnType<typeof ConfigMarkdown.parse>>
    try {
      document = await ConfigMarkdown.parse(input.entryFile)
    } catch (error) {
      const fallbackName = path.basename(path.dirname(input.entryFile))
      const details = frontmatterErrorDetails(error)
      return {
        diagnostics: [
          {
            code: "skill.frontmatter_parse_failed",
            severity: "error",
            name: fallbackName,
            source: input.source,
            path: input.entryFile,
            reason: {
              kind: "parse",
              ...(details.field ? { field: details.field } : {}),
              ...(details.line !== undefined ? { line: details.line } : {}),
              ...(details.column !== undefined ? { column: details.column } : {}),
              ...(details.position !== undefined ? { position: details.position } : {}),
            },
            message: details.field
              ? `Failed to parse YAML frontmatter in field '${details.field}': ${
                  details.detail?.replace(/:$/, "") ?? "invalid YAML"
                }.${details.quotingTip ? ` Tip: quote values containing ': ' with double quotes, e.g. description: "Keywords: foo".` : ""}`
              : error instanceof Error
                ? error.message
                : String(error),
          },
        ],
      }
    }

    const raw = document.data && typeof document.data === "object" ? (document.data as Record<string, unknown>) : {}
    const fallbackName =
      typeof raw.name === "string" && raw.name ? raw.name : path.basename(path.dirname(input.entryFile))
    const strictResult = Schema.safeParse(raw)

    if (input.mode === "strict") {
      if (!strictResult.success) {
        return {
          diagnostics: issuesToDiagnostics(strictResult.error.issues, {
            name: fallbackName,
            source: input.source,
            entryFile: input.entryFile,
            severity: "error",
          }),
        }
      }
      const directoryDiagnostics = validateDirectory(input.entryFile, strictResult.data).map((diagnostic) => ({
        ...diagnostic,
        source: input.source,
      }))
      if (directoryDiagnostics.length > 0) return { diagnostics: directoryDiagnostics }
      return { value: normalized(strictResult.data, document.content, []), diagnostics: [] }
    }

    const minimum = z
      .object({
        name: z.string().min(1),
        description: z.string().min(1),
      })
      .passthrough()
      .safeParse(raw)
    if (!minimum.success) {
      return {
        diagnostics: issuesToDiagnostics(minimum.error.issues, {
          name: fallbackName,
          source: input.source,
          entryFile: input.entryFile,
          severity: "error",
        }),
      }
    }

    const diagnostics: Diagnostic[] = []
    for (const field of Object.keys(raw)
      .filter((field) => !knownFields.has(field))
      .sort()) {
      diagnostics.push({
        code: "skill.vendor_field_unsupported",
        severity: "warning",
        name: minimum.data.name,
        source: input.source,
        path: input.entryFile,
        field,
        reason: { kind: "unknown_field" },
        message: `Unsupported ${input.source} field '${field}' is ignored by Synergy`,
      })
    }
    if (!strictResult.success) {
      diagnostics.push(
        ...issuesToDiagnostics(strictResult.error.issues, {
          name: minimum.data.name,
          source: input.source,
          entryFile: input.entryFile,
          severity: "warning",
        }).filter((diagnostic) => diagnostic.reason.kind !== "unrecognized_keys"),
      )
    }

    return {
      value: normalized(
        {
          name: minimum.data.name,
          description: minimum.data.description,
          license: typeof raw.license === "string" ? raw.license : undefined,
          compatibility: typeof raw.compatibility === "string" ? raw.compatibility : undefined,
          metadata:
            typeof raw.metadata === "object" && raw.metadata && !Array.isArray(raw.metadata)
              ? (raw.metadata as Record<string, unknown>)
              : undefined,

          "allowed-tools":
            typeof raw["allowed-tools"] === "string"
              ? raw["allowed-tools"]
              : Array.isArray(raw["allowed-tools"])
                ? raw["allowed-tools"].join(" ")
                : undefined,
          "user-invocable": typeof raw["user-invocable"] === "boolean" ? raw["user-invocable"] : true,
          "disable-model-invocation":
            typeof raw["disable-model-invocation"] === "boolean" ? raw["disable-model-invocation"] : false,
        },
        document.content,
        diagnostics,
      ),
      diagnostics,
    }
  }

  function normalized(manifest: Parsed, content: string, diagnostics: Diagnostic[]): Normalized {
    return {
      name: manifest.name,
      description: manifest.description,
      declaredLicense: manifest.license,
      declaredCompatibility: manifest.compatibility,
      invocation: {
        user: manifest["user-invocable"],
        model: !manifest["disable-model-invocation"],
      },
      content,
      diagnostics,
    }
  }
}
