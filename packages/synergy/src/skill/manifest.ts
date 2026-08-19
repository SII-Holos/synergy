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
      "allowed-tools": z.string().optional(),
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

  function issueFixHint(issue: z.core.$ZodIssue) {
    if (issue.path[0] === "allowed-tools" && issue.code === "invalid_type" && issue.expected === "string") {
      return "Use a space-separated string per agentskills.io, e.g. allowed-tools: Read Write"
    }
    return undefined
  }

  function issuesToDiagnostics(
    issues: z.core.$ZodIssue[],
    input: {
      name: string
      source: SkillSourceProfile.SourceID | "builtin" | "plugin"
      entryFile?: string
      severity: "error" | "warning"
    },
  ) {
    return issues.map((issue): Diagnostic => {
      const pathText = issue.path.length > 0 ? issue.path.join(".") : undefined
      const field = issue.code === "unrecognized_keys" ? issue.keys.join(", ") : pathText
      const hint = issueFixHint(issue)
      const message = pathText ? `Field '${pathText}': ${issue.message}${hint ? ` ${hint}` : ""}` : issue.message
      const reason: Record<string, unknown> = { kind: issue.code }
      if (field) reason.field = field
      if (issue.code === "invalid_type") {
        reason.expected = issue.expected
        if ("received" in issue) reason.received = issue.received
      }
      return {
        code: "skill.manifest_invalid",
        severity: input.severity,
        name: input.name,
        source: input.source,
        ...(input.entryFile ? { path: input.entryFile } : {}),
        ...(field ? { field } : {}),
        reason,
        message,
      }
    })
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
      return {
        diagnostics: issuesToDiagnostics(result.error.issues, {
          name: input.manifest.name,
          source: input.source,
          severity: "error",
        }),
      }
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

  type FrontmatterMark = {
    field?: string
    line?: number
    column?: number
    quoteExample?: string
  }

  function yamlException(error: unknown) {
    const candidate = (error as { cause?: unknown })?.cause ?? error
    if (!candidate || typeof candidate !== "object" || (candidate as { name?: unknown }).name !== "YAMLException") {
      return undefined
    }
    return candidate as {
      reason?: unknown
      mark?: { buffer?: unknown; line?: unknown; column?: unknown }
    }
  }

  function frontmatterMark(error: unknown): FrontmatterMark {
    const yaml = yamlException(error)
    if (!yaml?.mark) return {}
    const { buffer, line, column } = yaml.mark
    if (typeof buffer !== "string" || typeof line !== "number") return {}
    const blockLine = buffer.split("\n")[line]?.trim() ?? ""
    const colon = blockLine.indexOf(":")
    const field = colon > 0 ? blockLine.slice(0, colon).trim() : undefined
    const value = colon > 0 ? blockLine.slice(colon + 1).trim() : ""
    return {
      field,
      line: line + 1,
      column: typeof column === "number" ? column + 1 : undefined,
      quoteExample: field && value.includes(": ") && !value.includes('"') ? `${field}: "${value}"` : undefined,
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
      const mark = frontmatterMark(error)
      const yaml = yamlException(error)
      const detail =
        typeof yaml?.reason === "string" && yaml.reason
          ? yaml.reason
          : error instanceof Error
            ? error.message
            : String(error)
      const location = mark.line ? ` (line ${mark.line}${mark.column ? `, column ${mark.column}` : ""})` : ""
      const hint = mark.quoteExample
        ? ` Fix: quote the value with double quotes if it contains ': ', e.g. ${mark.quoteExample}`
        : ""
      return {
        diagnostics: [
          {
            code: "skill.frontmatter_parse_failed",
            severity: "error",
            name: fallbackName,
            source: input.source,
            path: input.entryFile,
            field: mark.field,
            reason: {
              kind: "parse",
              ...(mark.field ? { field: mark.field } : {}),
              ...(mark.line ? { line: mark.line } : {}),
              ...(mark.column ? { column: mark.column } : {}),
            },
            message: mark.field
              ? `Failed to parse YAML frontmatter in field '${mark.field}'${location}: ${detail}.${hint}`
              : `Failed to parse YAML frontmatter: ${detail}`,
          },
        ],
      }
    }

    const raw = document.data && typeof document.data === "object" ? (document.data as Record<string, unknown>) : {}
    if (Array.isArray(raw["allowed-tools"]) && raw["allowed-tools"].every((item) => typeof item === "string")) {
      raw["allowed-tools"] = raw["allowed-tools"].join(" ")
    }
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

          "allowed-tools": typeof raw["allowed-tools"] === "string" ? raw["allowed-tools"] : undefined,
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
