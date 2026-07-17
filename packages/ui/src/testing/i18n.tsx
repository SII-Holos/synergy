import { setupI18n as coreSetupI18n } from "@lingui/core"

export function setupI18n() {
  return coreSetupI18n({
    locale: "en",
    locales: ["en", "zh-CN"],
    messages: {},
  })
}
