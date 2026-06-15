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

/** Tokens that MUST NOT appear in P0 CSS files (forbidden / deprecated) */
const P0_FORBIDDEN_TOKENS = ["font-size-xs", "font-size-2xs", "font-size-3xs", "font-size-medium", "radius-12"]

/** P0 UI component CSS files scoped to Phase 3 */
const P0_UI_FILES = [
  "src/components/tabs.css",
  "src/components/switch.css",
  "src/components/checkbox.css",
  "src/components/dropdown-menu.css",
  "src/components/message-part.css",
  "src/components/diagram.css",
  "src/components/session-turn.css",
]

/** P0 app-side CSS files scoped to Phase 3 */
const P0_APP_FILES = ["../app/src/components/quick-actions.css"]

// ── Valid reference set (post-implementation target) ─────────

function buildP0ValidTokenSet(): Set<string> {
  const resolved = resolveTheme(synergyTheme)
  const valid = new Set<string>()

  // All resolveTheme output (color tokens)
  for (const key of Object.keys(resolved.light)) valid.add(key)

  // All P0 required tokens (to be added in this phase)
  for (const t of P0_REQUIRED_TOKENS) valid.add(t)

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
  ]
  for (const t of localTokens) valid.add(t)

  return valid
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe("Phase 3 — Visual Token Contract", () => {
  // ── Section 1: Required tokens exist in theme.css ───────────

  describe("1. Required P0 tokens declared in theme.css", () => {
    for (const token of P0_REQUIRED_TOKENS) {
      test(`--${token}`, async () => {
        const css = await readThemeCss()
        const props = extractCustomProps(css)
        expect(props.has(token), `theme.css 中未定义 --${token}`).toBe(true)
      })
    }

    test("font-size-x-small value is 11px", async () => {
      const css = await readThemeCss()
      expect(css).toMatch(/--font-size-x-small\s*:\s*11px/)
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

    test("dropdown-menu.css animation 使用 motion token", async () => {
      const css = await readFileSafe("src/components/dropdown-menu.css")
      const hasMotion = /var\(--motion-(duration|ease)/.test(css)
      expect(hasMotion, "dropdown-menu.css 应使用 motion token").toBe(true)
    })
  })

  describe("5. Pill / chip elements use --radius-full", () => {
    test("session-turn.css pill 元素使用 --radius-full", async () => {
      const css = await readFileSafe("src/components/session-turn.css")
      // chronicler-button, steps-trigger, retry-toggle all use 9999px
      const radiusFullRefs = (css.match(/var\(--radius-full\)/g) || []).length
      expect(radiusFullRefs, "session-turn.css 应将硬编码 9999px 替换为 var(--radius-full)").toBeGreaterThan(0)
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
