import type { Page } from "playwright"

export namespace BrowserEval {
  export type EvalMode = "readonly" | "trusted"

  export interface EvalOptions {
    mode: EvalMode
    maxBytes?: number
    timeoutMs?: number
  }

  export interface EvalResult {
    value: unknown
    bytes: number
    truncated: boolean
    duration: number
  }

  const DEFAULT_MAX_BYTES = 16_384
  const MAX_DEPTH = 10

  /**
   * Build an expression payload for readonly evaluation.
   * Sets throwOnSideEffect so the CDP runtime rejects side-effecting expressions.
   */
  export function buildReadonlyEval(expression: string): { expression: string; throwOnSideEffect: boolean } {
    return { expression, throwOnSideEffect: true }
  }

  /**
   * Build an expression payload for trusted evaluation.
   * Does not set throwOnSideEffect — the expression may have side effects.
   */
  export function buildTrustedEval(expression: string): { expression: string } {
    return { expression }
  }

  /**
   * Build an expression payload for CDP session Runtime.evaluate.
   * Sets throwOnSideEffect so the CDP runtime rejects side-effecting expressions.
   * Used for readonly eval via a Playwright-created CDP session.
   */
  export function buildCDPSessionEval(expression: string): { expression: string; throwOnSideEffect: boolean } {
    return { expression, throwOnSideEffect: true }
  }

  export async function evaluateReadonly(page: Page, expression: string): Promise<unknown> {
    const session = await page.context().newCDPSession(page)
    try {
      const result = (await session.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        throwOnSideEffect: true,
      })) as { result?: { value?: unknown } }
      return result.result?.value
    } finally {
      await session.detach().catch(() => {})
    }
  }

  /**
   * Build an expression payload for Playwright page.evaluate (trusted mode).
   * Does not set throwOnSideEffect — the expression may have side effects.
   * Access is gated behind isEvalAllowed("trusted").
   */
  export function buildPageEval(expression: string): { expression: string } {
    return { expression }
  }

  /**
   * JSON-stringify an eval result value with depth and size limits.
   * Handles circular references, functions, symbols, bigints, and non-finite numbers.
   * Returns a plain string (never throws).
   */
  export function sanitizeEvalResult(value: unknown, maxBytes: number = DEFAULT_MAX_BYTES): string {
    try {
      const json = stringifyValue(value, 0, new WeakSet())
      const encoded = new TextEncoder().encode(json)
      if (encoded.byteLength <= maxBytes) return json

      const truncated = new TextDecoder().decode(encoded.slice(0, maxBytes))
      return truncated + "\n...[truncated]"
    } catch {
      return String(value)
    }
  }

  /**
   * Check whether eval is permitted for a given mode and scope.
   * By default, readonly eval is always allowed and trusted eval is denied.
   */
  export function isEvalAllowed(mode: EvalMode, _scope?: string): boolean {
    if (mode === "readonly") return true
    return false
  }

  // ── internal serializer ──────────────────────────────────────────

  function stringifyValue(val: unknown, depth: number, seen: WeakSet<object>): string {
    if (depth > MAX_DEPTH) return '"..."'

    switch (typeof val) {
      case "string":
        return JSON.stringify(val)
      case "number":
        return isFinite(val) ? String(val) : "null"
      case "boolean":
        return String(val)
      case "undefined":
        return "null"
      case "function":
        return "null"
      case "symbol":
        return "null"
      case "bigint":
        return `"${val}n"`
    }

    if (val === null) return "null"

    // typeof val === "object"
    if (seen.has(val as object)) return '"<circular>"'
    seen.add(val as object)

    if (Array.isArray(val)) {
      const items = val.map((v) => stringifyValue(v, depth + 1, seen))
      return "[" + items.join(",") + "]"
    }

    const entries = Object.entries(val as Record<string, unknown>)
    if (entries.length === 0) return "{}"
    const pairs = entries.map(([k, v]) => JSON.stringify(k) + ":" + stringifyValue(v, depth + 1, seen))
    return "{" + pairs.join(",") + "}"
  }
}
