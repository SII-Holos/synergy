import { describe, expect, test } from "bun:test"
import { setupI18n } from "@lingui/core"
import type { SkillSummary } from "@ericsanchezok/synergy-sdk/client"
import {
  skillCanExport,
  skillCanonicalDiagnostics,
  skillDeclaredCompatibility,
  skillExportErrorPresentation,
  skillImportAccept,
  skillImportErrorPresentation,
  skillImportScopeOptions,
  skillInvocationLabel,
  skillPathLabel,
  skillViewCopy,
} from "../../../src/components/library/skill-view-model"

function makeI18n(locale: "en" | "zh-CN") {
  const i18n = setupI18n({ locale })
  i18n.loadAndActivate({
    locale,
    messages:
      locale === "zh-CN"
        ? {
            [skillViewCopy.invocationUserModel.id]: "用户和模型",
            [skillViewCopy.invocationUserOnly.id]: "仅用户",
            [skillViewCopy.invocationModelOnly.id]: "仅模型",
            [skillViewCopy.invocationUnavailable.id]: "不可调用",
            [skillViewCopy.importErrorInvalid.id]: "归档不是有效的 Skill 包。",
            [skillViewCopy.importErrorConflict.id]: "已存在同名 Skill。",
            [skillViewCopy.importErrorLimit.id]: "归档超过 Skill 导入限制。",
            [skillViewCopy.importErrorGeneric.id]: "Synergy 无法导入此 Skill 归档。",
            [skillViewCopy.importErrorGuidance.id]: "检查包内容，然后使用 .zip 或 .skill 归档重试。",
            [skillViewCopy.importErrorCodeLabel.id]: "代码",
            [skillViewCopy.importErrorPathLabel.id]: "路径",
            [skillViewCopy.importErrorNameLabel.id]: "Skill",
            [skillViewCopy.importErrorLimitLabel.id]: "限制",
            [skillViewCopy.importErrorActualLabel.id]: "实际",
          }
        : Object.fromEntries(Object.values(skillViewCopy).map((descriptor) => [descriptor.id, descriptor.message])),
  })
  return i18n
}

function baseSkill(overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    name: "standard-skill",
    description: "Domain-owned summary",
    location: "/project/.synergy/skill/standard-skill/SKILL.md",
    source: "synergy",
    scope: "project",
    compatibility: { level: "native", warnings: [], unsupported: [] },
    invocation: { user: true, model: true },
    exportable: true,
    diagnostics: [],
    ...overrides,
  }
}

describe("Skill Library view model", () => {
  test("shows the ZIP export action only from the public exportable flag", () => {
    expect(skillCanExport(baseSkill({ exportable: true }))).toBe(true)
    expect(skillCanExport(baseSkill({ exportable: false, source: "synergy", scope: "project" }))).toBe(false)
  })

  test("keeps invocation unavailable visible when both invocation flags are false", () => {
    const i18n = makeI18n("en")
    const translate = i18n._.bind(i18n)
    expect(skillInvocationLabel(baseSkill({ invocation: { user: true, model: true } }), translate)).toBe(
      "User and model",
    )
    expect(skillInvocationLabel(baseSkill({ invocation: { user: true, model: false } }), translate)).toBe("User only")
    expect(skillInvocationLabel(baseSkill({ invocation: { user: false, model: true } }), translate)).toBe("Model only")
    expect(skillInvocationLabel(baseSkill({ invocation: { user: false, model: false } }), translate)).toBe(
      "Invocation unavailable",
    )
  })

  test("reacts to locale changes for invocation chrome while preserving raw summary content", () => {
    const english = makeI18n("en")
    const chinese = makeI18n("zh-CN")
    const skill = baseSkill({ invocation: { user: false, model: false }, declaredCompatibility: "Claude Code 1.2" })

    expect(skillInvocationLabel(skill, english._.bind(english))).toBe("Invocation unavailable")
    expect(skillInvocationLabel(skill, chinese._.bind(chinese))).toBe("不可调用")
    expect(skillDeclaredCompatibility(skill)).toBe("Claude Code 1.2")
  })

  test("passes canonical diagnostics through without translating paths or identifiers", () => {
    const diagnostics = [
      {
        code: "skill.vendor_field_unsupported",
        severity: "warning" as const,
        name: "vendor-skill",
        source: "claude" as const,
        path: "/project/.claude/skills/vendor/SKILL.md",
        field: "x-vendor",
        reason: { field: "x-vendor" },
        message: "Unsupported field x-vendor",
      },
    ]

    expect(skillCanonicalDiagnostics(baseSkill({ diagnostics }))).toBe(diagnostics)
  })

  test("surfaces structured import errors with localized guidance and raw diagnostics", () => {
    const i18n = makeI18n("en")
    const presentation = skillImportErrorPresentation(
      {
        data: {
          code: "skill.archive_path_invalid",
          message: "Archive entry escapes destination",
          path: "../outside/SKILL.md",
        },
      },
      i18n._.bind(i18n),
    )

    expect(presentation.title).toBe("The archive is not a valid Skill package.")
    expect(presentation.guidance).toBe("Check the package, then try again with a .zip or .skill archive.")
    expect(presentation.details).toContainEqual({
      label: "The archive is not a valid Skill package.",
      value: "Archive entry escapes destination",
    })
    expect(presentation.details).toContainEqual({ label: "Code", value: "skill.archive_path_invalid" })
    expect(presentation.details).toContainEqual({ label: "Path", value: "../outside/SKILL.md" })
  })

  test("presents export errors without import recovery guidance", () => {
    const i18n = makeI18n("en")
    const presentation = skillExportErrorPresentation(
      {
        data: {
          code: "skill.export_not_standard",
          message: "Vendor-only fields require lenient loading",
          name: "vendor-skill",
        },
      },
      i18n._.bind(i18n),
    )

    expect(presentation.title).toBe("This Skill does not meet the strict export standard.")
    expect(presentation.details).toContainEqual({
      label: "This Skill does not meet the strict export standard.",
      value: "Vendor-only fields require lenient loading",
    })
    expect(presentation.details).toContainEqual({ label: "Skill", value: "vendor-skill" })
    expect(presentation).not.toHaveProperty("guidance")
  })

  test("offers project and global import destinations only with project context", () => {
    expect(skillImportScopeOptions(true)).toEqual(["project", "global"])
    expect(skillImportScopeOptions(false)).toEqual(["global"])
  })

  test("preserves cross-platform paths without guessing the user's home directory", () => {
    expect(skillPathLabel("/Users/alice/.claude/skills/demo/SKILL.md")).toBe(
      "/Users/alice/.claude/skills/demo/SKILL.md",
    )
    expect(skillPathLabel("/home/alice/.codex/skills/demo/SKILL.md")).toBe("/home/alice/.codex/skills/demo/SKILL.md")
    expect(skillPathLabel("C:\\Users\\alice\\.openclaw\\skills\\demo\\SKILL.md")).toBe(
      "C:\\Users\\alice\\.openclaw\\skills\\demo\\SKILL.md",
    )
    expect(skillPathLabel("builtin")).toBeUndefined()
  })

  test("uses the standard archive picker extension contract", () => {
    expect(skillImportAccept()).toBe(".zip,.skill")
  })
})
