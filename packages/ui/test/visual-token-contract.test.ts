import { describe, test, expect } from "bun:test"
import { resolveTheme } from "../src/theme/resolve"
import { synergyTheme } from "../src/theme/default-themes"

// ── Helpers ──────────────────────────────────────────────────

async function readThemeCss(): Promise<string> {
  return Bun.file("src/styles/theme.css").text()
}

async function readFileSafe(path: string): Promise<string> {
  const file = Bun.file(path)
  if (!(await file.exists())) return ""
  return file.text()
}

function extractCustomProps(css: string): Set<string> {
  const props = new Set<string>()
  const re = /^\s*--([\w-]+):/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(css)) !== null) props.add(m[1])
  return props
}

function extractVarRefs(css: string): string[] {
  const refs: string[] = []
  const re = /var\(--([\w-]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css)) !== null) refs.push(m[1])
  return refs
}

function extractCustomPropValue(css: string, token: string): string | undefined {
  const re = new RegExp(`^\\s*--${token}\\s*:\\s*([^;]+);`, "gm")
  const matches = [...css.matchAll(re)]
  return matches.at(-1)?.[1]?.trim()
}

function expectCustomPropValue(css: string, token: string, expected: string) {
  expect(extractCustomPropValue(css, token)?.toLowerCase()).toBe(expected.toLowerCase())
}

function extractLightFallbackBlock(css: string): string {
  const start = css.indexOf(":root:not([data-color-scheme]) {")
  const end = css.indexOf("@media (prefers-color-scheme: dark)")
  if (start === -1 || end === -1 || end <= start) throw new Error("Could not locate light fallback block")
  return css.slice(start, end)
}

function extractDarkFallbackBlock(css: string): string {
  const start = css.indexOf("@media (prefers-color-scheme: dark)")
  if (start === -1) throw new Error("Could not locate dark fallback block")
  return css.slice(start)
}

// ── P0 scope ─────────────────────────────────────────────────

/** Tokens this phase MUST add to theme.css */
const P0_REQUIRED_TOKENS = [
  "font-size-x-small",
  "font-weight-semibold",
  "line-height-normal",
  "font-feature-settings-mono",
  "radius-full",
  "shadow-sm",
  "motion-duration-fast",
  "motion-duration-base",
  "motion-duration-slow",
  "motion-ease-standard",
  "motion-ease-emphasized",
]

const SEMANTIC_UI_TYPE_TOKENS = [
  ["type-ui-page-title-size", "1.5rem"],
  ["type-ui-page-title-line-height", "1.875rem"],
  ["type-ui-section-title-size", "1rem"],
  ["type-ui-section-title-line-height", "1.375rem"],
  ["type-ui-row-title-size", "0.875rem"],
  ["type-ui-row-title-line-height", "1.25rem"],
  ["type-ui-body-size", "0.875rem"],
  ["type-ui-body-line-height", "1.375rem"],
  ["type-ui-control-size", "0.8125rem"],
  ["type-ui-control-line-height", "1.125rem"],
  ["type-ui-caption-size", "0.75rem"],
  ["type-ui-caption-line-height", "1rem"],
] as const

/** Tokens that MUST NOT appear in P0 CSS files (forbidden / deprecated) */
const P0_FORBIDDEN_TOKENS = ["font-size-xs", "font-size-2xs", "font-size-3xs", "font-size-medium", "radius-12"]

/** P0 UI component CSS files covered by the visual token contract */
const P0_UI_FILES = [
  "src/components/dialog.css",
  "src/components/tabs.css",
  "src/components/switch.css",
  "src/components/checkbox.css",
  "src/components/message-part.css",
  "src/components/diagram.css",
  "src/components/session-turn.css",
]

/** P0 app-side CSS files covered by the visual token contract */
const P0_APP_FILES = ["../app/src/components/quick-actions.css"]

// ── Valid reference set (post-implementation target) ─────────

function buildP0ValidTokenSet(): Set<string> {
  const resolved = resolveTheme(synergyTheme)
  const valid = new Set<string>()

  // All resolveTheme output (color tokens)
  for (const key of Object.keys(resolved.light)) valid.add(key)

  // All P0 required tokens (to be added in this phase)
  for (const t of P0_REQUIRED_TOKENS) valid.add(t)
  for (const [t] of SEMANTIC_UI_TYPE_TOKENS) valid.add(t)

  // Existing design tokens already in theme.css
  const existingDesigns = [
    "font-family-sans",
    "font-family-sans--font-feature-settings",
    "font-family-mono",
    "font-family-mono--font-feature-settings",
    "font-size-small",
    "font-size-base",
    "font-size-large",
    "font-size-x-large",
    "font-weight-regular",
    "font-weight-medium",
    "line-height-large",
    "line-height-x-large",
    "line-height-2x-large",
    "letter-spacing-normal",
    "letter-spacing-tight",
    "letter-spacing-tightest",
    "paragraph-spacing-base",
    "spacing",
    "breakpoint-sm",
    "breakpoint-md",
    "breakpoint-lg",
    "breakpoint-xl",
    "breakpoint-2xl",
    "container-3xs",
    "container-2xs",
    "container-xs",
    "container-sm",
    "container-md",
    "container-lg",
    "container-xl",
    "container-2xl",
    "container-3xl",
    "container-4xl",
    "container-5xl",
    "container-6xl",
    "container-7xl",
    "radius-xs",
    "radius-sm",
    "radius-md",
    "radius-lg",
    "radius-xl",
    "radius-2xl",
    "shadow-xs",
    "shadow-md",
    "shadow-lg",
    "shadow-xs-border",
    "shadow-xs-border-base",
    "shadow-xs-border-select",
    "shadow-xs-border-focus",
    "dialog-left-margin",
    "text-mix-blend-mode",
    "kb-popover-content-transform-origin",
    "kb-menu-content-transform-origin",
    "border-border-base",
    "border-border-weak-base",
    "border-border-strong",
    "border-border-warning-base",
    "bg-background-base",
    "text-text-strong",
    "ring-offset-surface-raised-stronger-non-alpha",
    "ring-text-interactive-base",
  ]
  for (const t of existingDesigns) valid.add(t)

  // Local component-scoped tokens
  const localTokens = [
    "session-turn-title-bg",
    "session-turn-title-border",
    "session-turn-title-highlight",
    "session-turn-title-glow",
    "workbench-canvas-bg",
    "workbench-panel-bg",
    "workbench-panel-bg-hover",
    "workbench-card-bg",
    "workbench-card-bg-hover",
    "workbench-card-secondary-bg",
    "workbench-control-bg",
    "workbench-control-bg-hover",
    "workbench-input-bg",
    "workbench-input-bg-hover",
    "workbench-popover-bg",
    "workbench-selected-bg",
    "workbench-selected-bg-hover",
    "workbench-border",
    "workbench-popover-shadow",
    "workbench-tab-shadow",
  ]
  for (const t of localTokens) valid.add(t)

  return valid
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe("Visual Token Contract", () => {
  // ── Section 1: Required tokens exist in theme.css ───────────

  describe("1. Required P0 tokens declared in theme.css", () => {
    for (const token of P0_REQUIRED_TOKENS) {
      test(`--${token}`, async () => {
        const css = await readThemeCss()
        const props = extractCustomProps(css)
        expect(props.has(token), `theme.css 中未定义 --${token}`).toBe(true)
      })
    }

    test("font-size-x-small value is 12px", async () => {
      const css = await readThemeCss()
      expect(css).toMatch(/--font-size-x-small\s*:\s*12px/)
    })

    test("font-weight-semibold value is 600", async () => {
      const css = await readThemeCss()
      expect(css).toMatch(/--font-weight-semibold\s*:\s*600/)
    })

    test("line-height-normal value is 1.5", async () => {
      const css = await readThemeCss()
      expect(css).toMatch(/--line-height-normal\s*:\s*1\.5\b/)
    })

    test("radius-full value is 9999px", async () => {
      const css = await readThemeCss()
      expect(css).toMatch(/--radius-full\s*:\s*9999px/)
    })

    test("motion-duration-fast value is 120ms", async () => {
      const css = await readThemeCss()
      expect(css).toMatch(/--motion-duration-fast\s*:\s*120ms/)
    })

    test("motion-duration-base value is 180ms", async () => {
      const css = await readThemeCss()
      expect(css).toMatch(/--motion-duration-base\s*:\s*180ms/)
    })

    test("motion-duration-slow value is 240ms", async () => {
      const css = await readThemeCss()
      expect(css).toMatch(/--motion-duration-slow\s*:\s*240ms/)
    })

    test("motion-ease-standard value is correct cubic-bezier", async () => {
      const css = await readThemeCss()
      expect(css).toMatch(/--motion-ease-standard\s*:\s*cubic-bezier\(0\.2,\s*0,\s*0,\s*1\)/)
    })

    test("motion-ease-emphasized value is correct cubic-bezier", async () => {
      const css = await readThemeCss()
      expect(css).toMatch(/--motion-ease-emphasized\s*:\s*cubic-bezier\(0\.16,\s*1,\s*0\.3,\s*1\)/)
    })
  })

  describe("1a. Semantic UI typography tokens declared in theme.css", () => {
    for (const [token, value] of SEMANTIC_UI_TYPE_TOKENS) {
      test(`--${token}`, async () => {
        const css = await readThemeCss()
        const props = extractCustomProps(css)
        expect(props.has(token), `theme.css 中未定义 --${token}`).toBe(true)
        expectCustomPropValue(css, token, value)
      })
    }
  })

  describe("1b. Modal material stays grounded", () => {
    test("dialog overlay uses a subtle blur rather than strong glass", async () => {
      const css = await readFileSafe("src/components/dialog.css")
      expect(css).toContain("backdrop-filter: blur(4px);")
      expect(css).not.toMatch(/backdrop-filter:\s*blur\((?:[5-9]|[1-9]\d)px\)/)
    })

    test("toast material remains solid instead of glassy", async () => {
      const css = await readFileSafe("src/components/toast.css")
      expect(css).toContain("background: var(--surface-raised-stronger-non-alpha);")
      expect(css).toContain("var(--workbench-popover-shadow")
      expect(css).not.toContain("backdrop-filter")
    })
  })

  describe("1b. Static theme fallback preserves neutral workbench surfaces", () => {
    test("light fallback uses a near-white canvas with white raised rows", async () => {
      const css = extractLightFallbackBlock(await readThemeCss())
      expectCustomPropValue(css, "background-stronger", "#FAFAFA")
      expectCustomPropValue(css, "surface-raised-base", "#FFFFFF")
      expectCustomPropValue(css, "surface-raised-stronger", "#FFFFFF")
      expectCustomPropValue(css, "surface-raised-stronger-non-alpha", "#FFFFFF")
      expectCustomPropValue(css, "surface-inset-base", "#F4F4F5")
    })

    test("dark fallback makes raised content brighter than the canvas", async () => {
      const css = extractDarkFallbackBlock(await readThemeCss())
      expectCustomPropValue(css, "background-stronger", "#0F0F10")
      expectCustomPropValue(css, "surface-raised-base", "#1B1B1D")
      expectCustomPropValue(css, "surface-raised-strong", "#222326")
      expectCustomPropValue(css, "surface-raised-stronger", "#2A2B2F")
      expectCustomPropValue(css, "surface-raised-stronger-non-alpha", "#2A2B2F")
    })
  })

  // ── Section 2: No forbidden tokens in P0 files ─────────────

  describe("2. Forbidden token references absent from P0 files", () => {
    for (const token of P0_FORBIDDEN_TOKENS) {
      test(`--${token}`, async () => {
        const hits: string[] = []
        const files = [...P0_UI_FILES, ...P0_APP_FILES]
        for (const fp of files) {
          const content = await readFileSafe(fp)
          if (!content) continue
          const refs = extractVarRefs(content)
          if (refs.includes(token)) hits.push(fp)
        }
        if (hits.length > 0) {
          throw new Error(`禁止 token --${token} 出现在以下文件中:\n` + hits.map((f) => `  ${f}`).join("\n"))
        }
      })
    }
  })

  // ── Section 3: P0 files have no broken token refs ──────────

  describe("3. P0 files — no unresolved token refs", () => {
    const valid = buildP0ValidTokenSet()

    for (const fp of [...P0_UI_FILES, ...P0_APP_FILES]) {
      test(fp, async () => {
        const content = await readFileSafe(fp)
        if (!content) return
        const refs = extractVarRefs(content)
        const unique = [...new Set(refs)]
        const broken = unique.filter((r) => !valid.has(r))
        if (broken.length > 0) {
          throw new Error(
            `${fp} 引用了未定义的 token:\n` +
              broken.map((t) => `  --${t}（不在 resolveTheme 输出、静态 token 集、或 P0 新增列表中）`).join("\n"),
          )
        }
      })
    }
  })

  // ── Section 4: Key files use motion/radius/shadow tokens ───

  describe("4. Transitions use motion tokens", () => {
    test("switch.css 状态 transition 使用 motion token", async () => {
      const css = await readFileSafe("src/components/switch.css")
      const hasMotion = /var\(--motion-duration-(fast|base|slow)\)/.test(css)
      expect(hasMotion, "switch.css 的 transition 应使用 --motion-duration-* token").toBe(true)
    })

    test("checkbox.css transition 使用 motion token", async () => {
      const css = await readFileSafe("src/components/checkbox.css")
      const hasMotion = /var\(--motion-(duration|ease)/.test(css)
      expect(hasMotion, "checkbox.css 应使用 motion token").toBe(true)
    })

    test("tabs.css transition 使用 motion token", async () => {
      const css = await readFileSafe("src/components/tabs.css")
      const hasMotion = /var\(--motion-(duration|ease)/.test(css)
      expect(hasMotion, "tabs.css 应使用 motion token").toBe(true)
    })
  })

  describe("5. Pill / chip elements use --radius-full", () => {
    test("session-turn.css 不硬编码 pill 圆角", async () => {
      const css = await readFileSafe("src/components/session-turn.css")
      expect(css, "session-turn.css 不应硬编码 9999px 圆角").not.toContain("9999px")
    })

    test("quick-actions.css pill 元素使用 --radius-full", async () => {
      const css = await readFileSafe("../app/src/components/quick-actions.css")
      const radiusFullRefs = (css.match(/var\(--radius-full\)/g) || []).length
      expect(radiusFullRefs, "quick-actions.css 的 pill 元素应使用 var(--radius-full)").toBeGreaterThan(0)
    })

    test("message-part.css anchored-chip 使用 --radius-full", async () => {
      const css = await readFileSafe("src/components/message-part.css")
      const radiusFullRefs = (css.match(/var\(--radius-full\)/g) || []).length
      expect(radiusFullRefs, "message-part.css 的 pill/chip 元素应使用 var(--radius-full)").toBeGreaterThan(0)
    })
  })

  describe("6. tabs.css shadow reference", () => {
    test("tabs.css 已正确引用 --shadow-sm", async () => {
      const css = await readFileSafe("src/components/tabs.css")
      // tabs.css pill variant already references var(--shadow-sm) — verify it's present
      expect(css).toContain("var(--shadow-sm)")
    })
  })

  // ── Section 7: Specific forbidden-substitution checks ──────

  describe("7. message-part.css token hygiene", () => {
    test("不再使用 --font-size-xs", async () => {
      const css = await readFileSafe("src/components/message-part.css")
      const refs = extractVarRefs(css)
      expect(refs, "message-part.css 不应再使用 --font-size-xs").not.toContain("font-size-xs")
    })

    test("小号字体使用 --font-size-x-small", async () => {
      const css = await readFileSafe("src/components/message-part.css")
      const hasXSmall = /var\(--font-size-x-small\)/.test(css)
      expect(hasXSmall, "message-part.css 的小号文字应使用 --font-size-x-small").toBe(true)
    })

    test("工具输出使用 workbench 内层 surface", async () => {
      const css = await readFileSafe("src/components/message-part.css")
      const outputBlock = css.match(/\[data-component="tool-output"\]\s*\{[\s\S]*?\n\}/)?.[0] ?? ""
      expect(outputBlock, "message-part.css 应定义 tool-output 样式块").not.toBe("")
      expect(outputBlock).toContain("var(--workbench-control-bg")
      expect(outputBlock).toContain("var(--workbench-border")
    })
  })

  describe("8. diagram.css font token usage", () => {
    test("diagram.css 已正确使用 --font-weight-semibold", async () => {
      const css = await readFileSafe("src/components/diagram.css")
      // diagram.css already references --font-weight-semibold — keep it functional
      expect(css).toContain("var(--font-weight-semibold)")
    })

    test("diagram.css 11px 字体使用 --font-size-x-small", async () => {
      const css = await readFileSafe("src/components/diagram.css")
      const hasXSmall = /var\(--font-size-x-small\)/.test(css)
      expect(hasXSmall, "diagram.css 的 11px 元素应使用 --font-size-x-small").toBe(true)
    })
  })
})
