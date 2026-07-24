import type { MessageDescriptor } from "@lingui/core"
import type { SkillSummary } from "@ericsanchezok/synergy-sdk/client"

export const skillViewCopy = {
  invocationUserModel: {
    id: "app.library.skills.invocation.userModel",
    message: "User and model",
  },
  invocationUserOnly: {
    id: "app.library.skills.invocation.userOnly",
    message: "User only",
  },
  invocationModelOnly: {
    id: "app.library.skills.invocation.modelOnly",
    message: "Model only",
  },
  invocationUnavailable: {
    id: "app.library.skills.invocation.unavailable",
    message: "Invocation unavailable",
  },
  importErrorInvalid: {
    id: "app.library.skills.import.error.invalid",
    message: "The archive is not a valid Skill package.",
  },
  importErrorConflict: {
    id: "app.library.skills.import.error.conflict",
    message: "A Skill with this name already exists.",
  },
  importErrorLimit: {
    id: "app.library.skills.import.error.limit",
    message: "The archive exceeds the Skill import limits.",
  },
  importErrorGeneric: {
    id: "app.library.skills.import.error.generic",
    message: "Synergy could not import this Skill archive.",
  },
  importErrorGuidance: {
    id: "app.library.skills.import.error.guidance",
    message: "Check the package, then try again with a .zip or .skill archive.",
  },
  importErrorCodeLabel: {
    id: "app.library.skills.import.error.codeLabel",
    message: "Code",
  },
  importErrorPathLabel: {
    id: "app.library.skills.import.error.pathLabel",
    message: "Path",
  },
  importErrorNameLabel: {
    id: "app.library.skills.import.error.nameLabel",
    message: "Skill",
  },
  importErrorLimitLabel: {
    id: "app.library.skills.import.error.limitLabel",
    message: "Limit",
  },
  importErrorActualLabel: {
    id: "app.library.skills.import.error.actualLabel",
    message: "Actual",
  },
  exportErrorNotStandard: {
    id: "app.library.skills.export.error.notStandard",
    message: "This Skill does not meet the strict export standard.",
  },
  exportErrorUnavailable: {
    id: "app.library.skills.export.error.unavailable",
    message: "This Skill cannot be exported.",
  },
  exportErrorNotFound: {
    id: "app.library.skills.export.error.notFound",
    message: "The Skill is no longer available.",
  },
  exportErrorGeneric: {
    id: "app.library.skills.export.error.generic",
    message: "Synergy could not export this Skill.",
  },
} as const satisfies Record<string, MessageDescriptor>

type Translator = (descriptor: MessageDescriptor) => string

type StructuredSkillErrorData = {
  code?: string
  message?: string
  path?: string
  name?: string
  limit?: number
  actual?: number
}

export type SkillErrorPresentation = {
  title: string
  details: Array<{ label: string; value: string }>
}

export type SkillImportErrorPresentation = SkillErrorPresentation & {
  guidance: string
}

export function skillCanExport(skill: Pick<SkillSummary, "exportable">) {
  return skill.exportable === true
}

export function skillInvocationLabel(skill: Pick<SkillSummary, "invocation">, translate: Translator) {
  if (skill.invocation.user && skill.invocation.model) return translate(skillViewCopy.invocationUserModel)
  if (skill.invocation.user) return translate(skillViewCopy.invocationUserOnly)
  if (skill.invocation.model) return translate(skillViewCopy.invocationModelOnly)
  return translate(skillViewCopy.invocationUnavailable)
}

export function skillDeclaredCompatibility(skill: Pick<SkillSummary, "declaredCompatibility">) {
  const value = skill.declaredCompatibility?.trim()
  return value ? value : undefined
}

export function skillCanonicalDiagnostics(skill: Pick<SkillSummary, "diagnostics">) {
  return skill.diagnostics
}

export function skillPathLabel(path?: string) {
  if (!path || path === "builtin") return undefined
  return path
}

export type SkillImportScope = "project" | "global"

export function skillImportScopeOptions(projectAvailable: boolean): SkillImportScope[] {
  return projectAvailable ? ["project", "global"] : ["global"]
}

export function skillImportAccept() {
  return ".zip,.skill"
}

export function skillExportFilename(skill: Pick<SkillSummary, "name">, contentDisposition?: string | null) {
  const filename = contentDisposition?.match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i)
  const raw = filename?.[1] ? decodeURIComponent(filename[1]) : filename?.[2]
  return raw?.trim() || `${skill.name}.zip`
}

export function skillImportErrorPresentation(error: unknown, translate: Translator): SkillImportErrorPresentation {
  const data = extractStructuredSkillError(error)
  const title = data ? skillImportErrorTitle(data.code, translate) : translate(skillViewCopy.importErrorGeneric)
  return {
    title,
    guidance: translate(skillViewCopy.importErrorGuidance),
    details: skillErrorDetails(error, data, title, translate),
  }
}

export function skillExportErrorPresentation(error: unknown, translate: Translator): SkillErrorPresentation {
  const data = extractStructuredSkillError(error)
  const title = skillExportErrorTitle(data?.code, translate)
  return {
    title,
    details: skillErrorDetails(error, data, title, translate),
  }
}

function skillErrorDetails(
  error: unknown,
  data: StructuredSkillErrorData | undefined,
  title: string,
  translate: Translator,
) {
  const details: SkillErrorPresentation["details"] = []
  if (data?.message) details.push({ label: title, value: data.message })
  if (data?.code) details.push({ label: translate(skillViewCopy.importErrorCodeLabel), value: data.code })
  if (data?.name) details.push({ label: translate(skillViewCopy.importErrorNameLabel), value: data.name })
  if (data?.path) details.push({ label: translate(skillViewCopy.importErrorPathLabel), value: data.path })
  if (typeof data?.limit === "number")
    details.push({ label: translate(skillViewCopy.importErrorLimitLabel), value: String(data.limit) })
  if (typeof data?.actual === "number")
    details.push({ label: translate(skillViewCopy.importErrorActualLabel), value: String(data.actual) })
  if (details.length === 0 && error instanceof Error && error.message) {
    details.push({ label: title, value: error.message })
  }
  return details
}

function skillImportErrorTitle(code: string | undefined, translate: Translator) {
  if (code === "skill.archive_conflict") return translate(skillViewCopy.importErrorConflict)
  if (code?.includes("limit")) return translate(skillViewCopy.importErrorLimit)
  if (code?.startsWith("skill.archive_")) return translate(skillViewCopy.importErrorInvalid)
  return translate(skillViewCopy.importErrorGeneric)
}

function skillExportErrorTitle(code: string | undefined, translate: Translator) {
  if (code === "skill.export_not_standard") return translate(skillViewCopy.exportErrorNotStandard)
  if (code === "skill.export_unavailable") return translate(skillViewCopy.exportErrorUnavailable)
  if (code === "skill.export_not_found") return translate(skillViewCopy.exportErrorNotFound)
  return translate(skillViewCopy.exportErrorGeneric)
}

function extractStructuredSkillError(error: unknown): StructuredSkillErrorData | undefined {
  if (!error || typeof error !== "object") return undefined
  const maybeData = (error as { data?: unknown }).data
  if (maybeData && typeof maybeData === "object") return maybeData as StructuredSkillErrorData
  if ("code" in error || "message" in error || "path" in error || "name" in error)
    return error as StructuredSkillErrorData
  return undefined
}
