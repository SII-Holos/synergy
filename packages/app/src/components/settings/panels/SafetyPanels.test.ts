import { describe, expect, test } from "bun:test"
import { setupI18n } from "@lingui/core"
import { controlProfileDescription, controlProfileLabel } from "./control-profile-copy"

const guarded = {
  id: "guarded",
  label: "Guarded",
  description: "Server fallback",
}

const custom = {
  id: "custom",
  label: "Custom profile",
  description: "Plugin-defined profile",
}

describe("control profile copy", () => {
  test("localizes built-in profiles and preserves unknown profile copy", () => {
    const i18n = setupI18n({ locale: "en" })
    const translate = i18n._.bind(i18n)
    expect(controlProfileLabel(guarded, translate)).toBe("Guarded")
    expect(controlProfileDescription(guarded, translate)).toContain("Auto-allow reads")
    expect(controlProfileLabel(custom, translate)).toBe("Custom profile")
    expect(controlProfileDescription(custom, translate)).toBe("Plugin-defined profile")

    i18n.loadAndActivate({
      locale: "zh-CN",
      messages: {
        "settings.controlProfile.guarded.label": "受控",
        "settings.controlProfile.guarded.description": "自动允许读取。",
      },
    })
    expect(controlProfileLabel(guarded, translate)).toBe("受控")
    expect(controlProfileDescription(guarded, translate)).toBe("自动允许读取。")
    expect(controlProfileLabel(custom, translate)).toBe("Custom profile")
  })
})
