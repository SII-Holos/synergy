import { STRUCTURAL_ROLES, type AccessibilityElement } from "./tab.js"

export namespace BrowserSnapshot {
  export interface FormatOptions {
    interactiveOnly?: boolean
    maxDepth?: number
  }

  export function formatText(elements: AccessibilityElement[], options?: FormatOptions): string {
    const maxDepth = options?.maxDepth ?? Infinity
    const interactiveOnly = options?.interactiveOnly ?? false
    let output = ""

    function walk(nodes: AccessibilityElement[], depth: number): boolean {
      if (depth > maxDepth) return false
      for (const el of nodes) {
        const isInteractive = !!el.ref
        const isStructural = STRUCTURAL_ROLES.has(el.role)
        const hasChildren = el.children.length > 0
        if (!isInteractive && !isStructural && !hasChildren) continue
        if (interactiveOnly && !isInteractive && !hasChildren) {
          walk(el.children, depth + 1)
          continue
        }
        const indent = "  ".repeat(depth)
        const name = el.name ? ` "${el.name}"` : ""
        const ref = el.ref ? ` [ref=${el.ref}]` : ""
        output += `${indent}- ${el.role}${name}${ref}\n`
        if (!walk(el.children, depth + 1)) return false
      }
      return true
    }

    walk(elements, 0)
    return output.trimEnd()
  }
}
