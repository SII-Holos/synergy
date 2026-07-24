import { describe, expect, test } from "bun:test"
import { setupI18n } from "@lingui/core"
import { AP } from "../../src/app-i18n"

function translate(locale: "en" | "zh-CN") {
  const i18n = setupI18n()
  i18n.loadAndActivate({
    locale,
    messages:
      locale === "en"
        ? {}
        : {
            "app.error.title": "Synergy 需要快速刷新",
            "app.error.subtitle": "界面遇到问题，暂时无法继续显示。",
            "app.error.taskSafety": "正在运行的任务是安全的。重新加载只会刷新界面，不会停止服务器上的工作。",
            "app.error.reloadInterface": "重新加载界面",
            "app.error.technicalDetails": "技术详情",
            "app.error.report": "在 GitHub 上报告此问题",
            "app.error.versionLabel": "版本：{version}",
          },
  })
  return {
    title: i18n._(AP.errorTitle),
    subtitle: i18n._(AP.errorSubtitle),
    safety: i18n._(AP.errorTaskSafety),
    reload: i18n._(AP.errorReloadInterface),
    details: i18n._(AP.errorTechnicalDetails),
  }
}

describe("error page recovery copy", () => {
  test("prioritizes recovery and task safety over diagnostics", () => {
    const copy = translate("en")

    expect(copy.title).toBe("Synergy needs a quick refresh")
    expect(copy.subtitle).toBe("The interface ran into a problem and cannot continue displaying this view.")
    expect(copy.safety).toContain("Your running tasks are safe.")
    expect(copy.safety).toContain("Reloading only refreshes this interface")
    expect(copy.reload).toBe("Reload interface")
    expect(copy.details).toBe("Technical details")
  })

  test("provides complete Simplified Chinese recovery guidance", () => {
    const copy = translate("zh-CN")

    expect(copy.title).toBe("Synergy 需要快速刷新")
    expect(copy.subtitle).toBe("界面遇到问题，暂时无法继续显示。")
    expect(copy.safety).toContain("正在运行的任务是安全的")
    expect(copy.reload).toBe("重新加载界面")
    expect(copy.details).toBe("技术详情")
  })
})
