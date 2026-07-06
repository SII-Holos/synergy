import DOMPurify from "dompurify"

// Sanitize model/tool-authored HTML before it reaches innerHTML (#350 D5). The
// marked pipeline passes raw HTML through, and the SPA CSP allows inline
// scripts, so an `<img onerror=...>` in a reply would otherwise execute in a
// client that holds full local-server API access. DOMPurify's default allowlist
// keeps shiki spans (class/style) and katex MathML/SVG while stripping scripts,
// event handlers, and javascript: URLs. Guarded so non-DOM contexts (SSR/tests
// without a window) pass the HTML through unchanged.
export function sanitizeHtml(html: string): string {
  if (typeof window === "undefined") return html
  return DOMPurify.sanitize(html, { ADD_ATTR: ["target"] })
}
