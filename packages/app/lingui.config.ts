import { defineConfig } from "@lingui/cli"
import { formatter } from "@lingui/format-po"

export default defineConfig({
  sourceLocale: "en",
  locales: ["en", "zh-CN", "pseudo"],
  pseudoLocale: { locale: "pseudo", prepend: "⟦", append: "⟧", extend: 0.3 },
  fallbackLocales: { pseudo: "en" },
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
