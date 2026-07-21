import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { hasIcon } from "../src/plugin/icon-registry"
import "../src/plugin/builtin-icons"
import { getSemanticIcon, SemanticIconToken } from "../src/components/semantic-icon"

const repoRoot = path.resolve(import.meta.dir, "../../..")

const rawIconPatterns = [
  /<Icon\b[^>]*\bname=(?:\{)?["']([^"']+)["']/g,
  /<IconButton\b[^>]*\bicon=(?:\{)?["']([^"']+)["']/g,
  /<Button\b[^>]*\bicon=(?:\{)?["']([^"']+)["']/g,
  /<(?:Panel\.Action|AppPanel\.Action)\b[^>]*\bicon=(?:\{)?["']([^"']+)["']/g,
  /\bicon:\s*["']([a-z0-9-]+)["']/g,
]

const rawIconExceptionReasons: Record<string, string> = {
  "packages/app/src/components/agenda/form.tsx":
    "Kobalte select controls use structural chevrons and selected-option checks.",
  "packages/app/src/components/prompt-input/permission-selector.tsx":
    "Toolbar selector trigger uses a structural disclosure chevron.",
  "packages/app/src/components/prompt-input/start-options.tsx":
    "Toolbar selector trigger uses a structural disclosure chevron.",
  "packages/app/src/components/settings/components/AccountToggleCard.tsx":
    "Settings select trigger uses a structural disclosure chevron.",
  "packages/app/src/components/settings/components/ModelRoleRow.tsx":
    "Settings model selectors use structural disclosure chevrons.",
  "packages/ui/src/components/collapsible.tsx": "Shared primitive drag/disclosure affordance.",
  "packages/ui/src/components/dialog.tsx": "Shared dialog primitive close affordance.",
  "packages/ui/src/components/dag-graph.tsx": "Graph node detail uses a structural drag/grip affordance.",
  "packages/ui/src/components/image-preview.tsx": "Shared image viewer controls are base media-control affordances.",
  "packages/ui/src/components/list.tsx": "Shared list primitive search, selected, and clear affordances.",
  "packages/ui/src/components/popover.tsx": "Shared popover primitive close affordance.",
  "packages/ui/src/components/select.tsx": "Shared select primitive check and disclosure affordances.",
  "packages/ui/src/components/session-review.tsx":
    "Review outline uses structural grip controls for expand/collapse affordances.",
  "packages/ui/src/components/session-turn.tsx": "Diff accordion uses a structural grip affordance.",
  "packages/ui/src/components/toast.tsx": "Shared toast primitive close affordance.",
}

const excludedRawIconPaths = new Set([
  "packages/ui/src/components/anchored-tool-card.tsx",
  "packages/ui/src/components/message-part.tsx",
  "packages/ui/src/components/tool/classifier.ts",
])

const excludedRawIconPathFragments = [
  "/packages/ui/src/components/tool/renders/",
  "/packages/ui/src/components/file-icon",
  "/packages/app/src/plugin/registries/",
]

function collectFiles(dir: string, result: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(full)
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") continue
      throw error
    }
    if (stat.isDirectory()) {
      collectFiles(full, result)
      continue
    }
    if (full.endsWith(".tsx") && !full.endsWith(".test.tsx")) result.push(full)
  }
  return result
}

function isExcludedPath(file: string): boolean {
  const relative = path.relative(repoRoot, file).replace(/\\/g, "/")
  if (excludedRawIconPaths.has(relative)) return true
  return excludedRawIconPathFragments.some((fragment) => `/${relative}`.includes(fragment))
}

function componentIconNames(): Set<string> {
  const source = readFileSync(path.join(repoRoot, "packages/ui/src/components/icon.tsx"), "utf8")
  const start = source.indexOf("const icons = {")
  const end = source.indexOf("\n}\n\nexport type IconName", start)
  const block = source.slice(start, end)
  const names = new Set<string>()
  for (const match of block.matchAll(/^\s*(?:"([^"]+)"|([a-z][a-z0-9]*)):/gm)) {
    names.add(match[1] ?? match[2])
  }
  return names
}

describe("semantic icons", () => {
  test("every token resolves to its configured icon key", () => {
    for (const token of Object.keys(SemanticIconToken) as Array<keyof typeof SemanticIconToken>) {
      expect(getSemanticIcon(token)).toBe(SemanticIconToken[token])
    }
  })

  test("blueprint uses a plan icon distinct from approval stamping", () => {
    expect(getSemanticIcon("blueprint.main")).toBe("clipboard-list")
    expect(getSemanticIcon("blueprint.main")).not.toBe("stamp")
  })

  test("semantic tokens do not reuse Lucide glyphs for different meanings", () => {
    const grouped = new Map<string, string[]>()
    for (const [token, icon] of Object.entries(SemanticIconToken)) {
      grouped.set(icon, [...(grouped.get(icon) ?? []), token])
    }

    const duplicates = Array.from(grouped.entries())
      .filter(([, tokens]) => tokens.length > 1)
      .map(([icon, tokens]) => `${icon}: ${tokens.sort().join(", ")}`)

    expect(duplicates).toEqual([])
  })

  test("semantic token glyphs are registered and renderable built-in icons", () => {
    const missingFromRegistry = Object.entries(SemanticIconToken)
      .filter(([, icon]) => !hasIcon(icon))
      .map(([token, icon]) => `${token}: ${icon}`)

    const componentIcons = componentIconNames()
    const missingFromComponentMap = Object.entries(SemanticIconToken)
      .filter(([, icon]) => !componentIcons.has(icon))
      .map(([token, icon]) => `${token}: ${icon}`)
    expect(missingFromRegistry).toEqual([])
    expect(missingFromComponentMap).toEqual([])
  })

  test("product UI does not use raw Lucide literals outside documented exceptions", () => {
    const roots = [path.join(repoRoot, "packages/app/src"), path.join(repoRoot, "packages/ui/src/components")]
    const violations: string[] = []

    for (const root of roots) {
      for (const file of collectFiles(root)) {
        if (isExcludedPath(file)) continue

        const relative = path.relative(repoRoot, file).replace(/\\/g, "/")
        const source = readFileSync(file, "utf8")
        for (const pattern of rawIconPatterns) {
          pattern.lastIndex = 0
          for (const match of source.matchAll(pattern)) {
            const line = source.slice(0, match.index).split("\n").length
            if (rawIconExceptionReasons[relative]) continue
            violations.push(`${relative}:${line} raw ${match[1]}`)
          }
        }
      }
    }

    expect(violations).toEqual([])
  })
})
