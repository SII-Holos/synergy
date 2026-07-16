import { defineConfig } from "@lingui/cli"
import { formatter } from "@lingui/format-po"

export default defineConfig({
  sourceLocale: "en",
  locales: ["en", "zh-CN"],
  pseudoLocale: { locale: "en", extend: 0.3 },
  catalogs: [
    {
      path: "<rootDir>/src/locales/{locale}/messages",
      include: ["src", "../ui/src"],
      exclude: ["**/*.test.*", "**/*.spec.*", "**/node_modules/**", "**/dist/**"],
    },
  ],
  format: formatter({ explicitIdAsDefault: true }),
  compileNamespace: "es",
})
