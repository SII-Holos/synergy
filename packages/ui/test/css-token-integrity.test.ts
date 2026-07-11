import { describe, test, expect } from "bun:test"
import { resolveTheme } from "../src/theme/resolve"
import { synergyTheme } from "../src/theme/default-themes"

type FileSet = {
  globs: string[]
  label: string
}

const PHASE2_UI_FILES: FileSet[] = [
  {
    label: "Phase 2 — UI token refs",
    globs: [
      "src/components/markdown.css",
      "src/components/session-resonance-popover.css",
      "src/components/diagram.css",
      "src/components/session-turn.css",
      "src/components/icon-button.css",
    ],
  },
]

const APP_FILES = [
  "../app/src/components/prompt-input/quick-actions.css",
  "../app/src/components/header-bar.css",
  "../app/src/components/context-bar.css",
  "../app/src/components/dialog/dialog-settings.css",
  "../app/src/components/dialog/dialog-settings.tsx",
]

const KNOWN_STATIC_TOKENS = new Set([
  "font-family-sans",
  "font-family-sans--font-feature-settings",
  "font-family-mono",
  "font-family-mono--font-feature-settings",
  "font-size-small",
  "font-size-base",
  "font-size-large",
  "font-size-x-large",
  "font-size-lg",
  "font-size-x-small",
  "font-weight-regular",
  "font-weight-medium",
  "font-weight-semibold",
  "line-height-large",
  "line-height-x-large",
  "line-height-2x-large",
  "line-height-normal",
  "type-ui-page-title-size",
  "type-ui-page-title-line-height",
  "type-ui-section-title-size",
  "type-ui-section-title-line-height",
  "type-ui-row-title-size",
  "type-ui-row-title-line-height",
  "type-ui-body-size",
  "type-ui-body-line-height",
  "type-ui-control-size",
  "type-ui-control-line-height",
  "type-ui-caption-size",
  "type-ui-caption-line-height",
  "letter-spacing-normal",
  "letter-spacing-tight",
  "letter-spacing-tightest",
  "paragraph-spacing-base",
  "font-feature-settings-mono",
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
  "radius-full",
  "shadow-xs",
  "shadow-sm",
  "shadow-md",
  "shadow-lg",
  "shadow-xs-border",
  "shadow-xs-border-base",
  "shadow-xs-border-select",
  "shadow-xs-border-focus",
  "text-mix-blend-mode",
  "kb-popover-content-transform-origin",
  "motion-duration-fast",
  "motion-duration-base",
  "motion-duration-slow",
  "motion-ease-standard",
  "motion-ease-emphasized",
  "border-border-base",
  "border-border-weak-base",
  "border-border-strong",
  "border-border-warning-base",
  "bg-background-base",
  "text-text-strong",
  "ring-offset-surface-raised-stronger-non-alpha",
  "ring-text-interactive-base",
])

const KNOWN_LOCAL_TOKENS = new Set([
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
])

function extractVarRefs(css: string): string[] {
  const refs: string[] = []
  const re = /var\(--([\w-]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css)) !== null) {
    refs.push(m[1])
  }
  return refs
}
function extractCustomProps(css: string): Set<string> {
  const props = new Set<string>()
  const re = /^\s*--([\w-]+):/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(css)) !== null) props.add(m[1])
  return props
}

function extractTailwindVarRefs(tsx: string): string[] {
  const refs: string[] = []
  const re = /\[var\(--([\w-]+)\)\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(tsx)) !== null) {
    refs.push(m[1])
  }
  return refs
}

async function readFileSafe(path: string): Promise<string> {
  const file = Bun.file(path)
  if (!(await file.exists())) return ""
  return file.text()
}

function extractRuleBlock(css: string, selector: string): string {
  const selectorStart = css.indexOf(selector)
  if (selectorStart === -1) return ""

  const blockStart = css.indexOf("{", selectorStart)
  if (blockStart === -1) return ""

  let depth = 0
  for (let i = blockStart; i < css.length; i++) {
    const char = css[i]
    if (char === "{") depth++
    if (char !== "}") continue
    depth--
    if (depth === 0) return css.slice(selectorStart, i + 1)
  }

  return ""
}

function buildValidTokenSet(): Set<string> {
  const resolved = resolveTheme(synergyTheme)
  const valid = new Set<string>()
  for (const key of Object.keys(resolved.light)) {
    valid.add(key)
  }
  for (const t of KNOWN_STATIC_TOKENS) valid.add(t)
  for (const t of KNOWN_LOCAL_TOKENS) valid.add(t)
  return valid
}

function assertNoBrokenTokenRefs(
  filepath: string,
  refs: string[],
  validTokens: Set<string>,
  localTokens = new Set<string>(),
) {
  const uniqueRefs = [...new Set(refs)]
  const broken = uniqueRefs.filter((r) => !validTokens.has(r) && !localTokens.has(r))

  if (broken.length > 0) {
    throw new Error(
      `Broken token references in ${filepath}:\n` +
        broken.map((t) => `  --${t} → NOT in resolveTheme output or static tokens`).join("\n"),
    )
  }
}

describe("CSS Token Integrity", () => {
  const validTokens = buildValidTokenSet()

  test("valid token set is non-empty", () => {
    expect(validTokens.size).toBeGreaterThan(80)
  })

  for (const fileSet of PHASE2_UI_FILES) {
    describe(fileSet.label, () => {
      for (const glob of fileSet.globs) {
        test(`${glob} — all var(--token) refs are valid`, async () => {
          const css = await readFileSafe(glob)
          if (!css) return
          assertNoBrokenTokenRefs(glob, extractVarRefs(css), validTokens, extractCustomProps(css))
        })
      }
    })
  }

  describe("Phase 2 — app-side token refs", () => {
    for (const filepath of APP_FILES) {
      test(`${filepath} — all var(--token) refs are valid`, async () => {
        const content = await readFileSafe(filepath)
        if (!content) return

        const isTsx = filepath.endsWith(".tsx")
        const refs = isTsx ? [...extractVarRefs(content), ...extractTailwindVarRefs(content)] : extractVarRefs(content)
        assertNoBrokenTokenRefs(filepath, refs, validTokens, extractCustomProps(content))
      })
    }
  })

  test("index.html uses synergy theme preload naming", async () => {
    const source = await readFileSafe("../app/index.html")
    expect(source).toContain('id="synergy-theme-preload-script"')
    expect(source).not.toContain("oc-theme")
  })

  test("session-turn.css has no dead dark theme selectors", async () => {
    const css = await readFileSafe("src/components/session-turn.css")
    expect(css).not.toMatch(/\[data-theme="dark"\]/)
    expect(css).not.toMatch(/\.dark\s*\{/)
  })

  test("theme.css has no OC-1 fallback comment", async () => {
    const css = await readFileSafe("src/styles/theme.css")
    expect(css).not.toContain("OC-1")
  })

  test("no formerly broken token references remain in P0 scope files", async () => {
    const p0Files = [
      "src/components/markdown.css",
      "src/components/session-resonance-popover.css",
      "src/components/diagram.css",
      "../app/src/components/prompt-input/quick-actions.css",
    ]

    const mustNotReappear = new Set([
      "surface-raised-solid",
      "text-disabled",
      "icon-strong",
      "text-success-base",
      "text-danger-base",
      "text-critical-base",
    ])

    const allRefs: string[] = []
    for (const fp of p0Files) {
      const content = await readFileSafe(fp)
      if (content) allRefs.push(...extractVarRefs(content))
    }

    const remaining = [...new Set(allRefs)].filter((r) => mustNotReappear.has(r))
    if (remaining.length > 0) {
      throw new Error(`Formerly broken P0 refs still present:\n` + remaining.map((t) => `  --${t}`).join("\n"))
    }
  })

  test("session-turn.css has no legacy token references", async () => {
    const css = await readFileSafe("src/components/session-turn.css")
    const legacy = extractVarRefs(css).filter(
      (r) => r.startsWith("color-text-") || r === "color-text-dimmed" || r === "color-text-link",
    )
    if (legacy.length > 0) {
      throw new Error(`Legacy token refs in session-turn.css:\n` + legacy.map((t) => `  --${t}`).join("\n"))
    }
  })

  test("markdown code blocks stay document surfaces instead of gray control slabs", async () => {
    const css = await readFileSafe("src/components/markdown.css")
    const codeBlock = extractRuleBlock(css, '[data-slot="markdown-code-block"]')
    expect(codeBlock).toContain("background-color: var(--workbench-control-bg")

    const lightCodeBlock = extractRuleBlock(
      css,
      ':root[data-color-scheme="light"] [data-component="markdown"] [data-slot="markdown-code-block"]',
    )
    expect(lightCodeBlock).toContain("var(--surface-base) 92%")

    const lightInlineCode = extractRuleBlock(
      css,
      ':root[data-color-scheme="light"] [data-component="markdown"] :not(pre) > code',
    )
    expect(lightInlineCode).toContain("var(--surface-base) 78%")

    const header = extractRuleBlock(css, '[data-slot="markdown-code-header"]')
    expect(header).toContain("background-color: transparent")

    const copyButton = extractRuleBlock(css, '[data-slot="markdown-code-copy"]')
    expect(copyButton).toContain("border: 0")
    expect(copyButton).toContain("background: transparent")
  })

  test("session turn timeline spacing uses semantic rhythm tiers", async () => {
    const css = await readFileSafe("src/components/session-turn.css")
    const timelineStart = css.indexOf('[data-slot="session-turn-timeline-item"] +')
    const timelineEnd = css.indexOf('[data-slot="session-turn-timeline-item"] [data-component="attachment-gallery"]')
    expect(timelineStart).toBeGreaterThan(-1)
    expect(timelineEnd).toBeGreaterThan(timelineStart)

    const rhythm = css.slice(timelineStart, timelineEnd)
    expect(rhythm).toContain("margin-top: 6px;")
    expect(rhythm).toContain("margin-top: 8px;")
    expect(rhythm).toContain("margin-top: 10px;")
    expect(rhythm).toContain("margin-top: 12px;")
    expect(rhythm).not.toMatch(/margin-top:\s*[345]px/)
  })

  test("icon-button.css has no commented-out old code blocks", async () => {
    const css = await readFileSafe("src/components/icon-button.css")
    const commentBlockCount = (css.match(/\/\*\s*\n/g) || []).length
    expect(commentBlockCount).toBe(0)
  })

  test("no formerly broken P2 token references remain in app-side files", async () => {
    const p2Files = [
      "../app/src/components/header-bar.css",
      "../app/src/components/context-bar.css",
      "../app/src/components/dialog/dialog-settings.css",
      "../app/src/components/dialog/dialog-settings.tsx",
    ]

    const mustNotReappear = new Set([
      "icon-success",
      "icon-warning",
      "icon-danger",
      "text-warning-base",
      "text-critical-base",
    ])

    const allRefs: string[] = []
    for (const fp of p2Files) {
      const content = await readFileSafe(fp)
      if (!content) continue
      const isTsx = fp.endsWith(".tsx")
      allRefs.push(
        ...(isTsx ? [...extractVarRefs(content), ...extractTailwindVarRefs(content)] : extractVarRefs(content)),
      )
    }

    const remaining = [...new Set(allRefs)].filter((r) => mustNotReappear.has(r))
    if (remaining.length > 0) {
      throw new Error(`Formerly broken P2 refs still present:\n` + remaining.map((t) => `  --${t}`).join("\n"))
    }
  })
})
