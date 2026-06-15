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
  "../app/src/components/quick-actions.css",
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
  "font-weight-regular",
  "font-weight-medium",
  "font-weight-semibold",
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
  "session-turn-title-bg",
  "session-turn-title-border",
  "session-turn-title-highlight",
  "session-turn-title-glow",
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

function assertNoBrokenTokenRefs(filepath: string, refs: string[], validTokens: Set<string>) {
  const uniqueRefs = [...new Set(refs)]
  const broken = uniqueRefs.filter((r) => !validTokens.has(r))

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
          assertNoBrokenTokenRefs(glob, extractVarRefs(css), validTokens)
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
        assertNoBrokenTokenRefs(filepath, refs, validTokens)
      })
    }
  })

  test("context.tsx uses 'synergy-theme' style ID, not 'oc-theme'", async () => {
    const source = await readFileSafe("src/theme/context.tsx")
    expect(source).toContain('"synergy-theme"')
    expect(source).not.toContain('"oc-theme"')
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
      "../app/src/components/quick-actions.css",
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
