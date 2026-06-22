import { STRUCTURAL_ROLES, type AccessibilityElement } from "./tab.js"

export namespace BrowserSnapshot {
  const MAX_OUTPUT_LENGTH = 6000

  interface FormatOptions {
    interactiveOnly?: boolean
    maxDepth?: number
  }

  /** Format accessibility tree into agent-readable text with @eN refs. */
  export function formatText(elements: AccessibilityElement[], options?: FormatOptions): string {
    const maxDepth = options?.maxDepth ?? Infinity
    const interactiveOnly = options?.interactiveOnly ?? false
    let output = ""

    function walk(nodes: AccessibilityElement[], depth: number): boolean {
      if (depth > maxDepth) return false
      if (output.length > MAX_OUTPUT_LENGTH) return false
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
        if (output.length > MAX_OUTPUT_LENGTH) {
          output += `${indent}  ... (truncated)\n`
          return false
        }
        if (!walk(el.children, depth + 1)) return false
      }
      return true
    }

    walk(elements, 0)
    return output.trimEnd()
  }

  /** Format a single element as inspectable text. */
  export function formatElement(el: AccessibilityElement): string {
    const parts: string[] = []
    parts.push(`<${el.role}>`)
    if (el.name) parts.push(` name="${el.name}"`)
    if (el.value !== undefined) parts.push(` value="${el.value}"`)
    if (el.ref) parts.push(` ref="${el.ref}"`)
    return parts.join("")
  }
}
