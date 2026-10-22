import DOMPurify from "dompurify"
import { ResourceReference } from "@ericsanchezok/synergy-util/resource-reference"

// Sanitize model/tool-authored HTML before it reaches innerHTML (#350 D5). The
// marked pipeline passes raw HTML through, and the SPA CSP allows inline
// scripts, so an `<img onerror=...>` in a reply would otherwise execute in a
// client that holds full local-server API access. DOMPurify's default allowlist
// keeps shiki spans (class/style) and katex MathML/SVG while stripping scripts,
// global style blocks, event handlers, and javascript: URLs. Guarded so non-DOM
// contexts (SSR/tests without a window) pass the HTML through unchanged.

// Authors write managed references (`asset:`, `note:`, workspace paths) in raw
// HTML as often as in Markdown syntax, but DOMPurify's URI allowlist admits only
// browser-native schemes. Every such `src`/`href` was therefore dropped without
// an error: an image lost its pixels, a document link lost its target. Managed
// references move to the `data-resource-reference` attribute Markdown rendering
// already produces, and the resource observer resolves that to a same-origin URL
// at bind time. The allowlist stays intact: `javascript:` and unknown schemes
// are still removed, because only references `ResourceReference.parse`
// understands are preserved.
const referenceCarriers: Record<string, readonly string[]> = {
  a: ["href"],
  area: ["href"],
  audio: ["src"],
  img: ["src", "srcset"],
  source: ["src", "srcset"],
  track: ["src"],
  video: ["src", "poster"],
}

// Frames are forbidden tags, so the node disappears before any attribute hook
// can preserve the reference it points at.
const referenceFrames = new Set(["embed", "iframe", "object"])

function normalizeScheme(value: string) {
  return value.replace(/^([a-z][a-z\d+.-]*):/i, (_, scheme: string) => `${scheme.toLowerCase()}:`)
}

/** Returns the reference only when it needs managed resolution: browser-native
 *  URLs, inline images and in-page anchors stay on their own attributes. */
function managedReference(value: string) {
  const reference = ResourceReference.parse(normalizeScheme(value))
  if (reference.kind === "unavailable") return
  if (reference.kind === "anchor" || reference.kind === "image" || reference.kind === "url") return
  return reference
}

/** A `srcset` candidate list collapses to its first entry when that entry is a
 *  managed reference: the asset or file identifies one piece of media, so the
 *  density variants describe the same target instead of distinct sources. */
function srcsetReference(value: string) {
  const first = value.split(",")[0]?.trim().split(/\s+/)[0]
  return first && managedReference(first) ? first : undefined
}

function carrierReference(element: Element, attribute: string) {
  const value = element.getAttribute(attribute)
  if (!value) return
  const reference = attribute === "srcset" ? srcsetReference(value) : value
  return reference && managedReference(reference) ? reference : undefined
}

/** One element carries one managed reference. The primary source attribute wins
 *  over a secondary one (`src` over `poster`), and a lesser attribute pointing at
 *  a managed reference is dropped, because the observer can only resolve the
 *  element's single reference slot. */
function referenceAttribute(node: Element, data: { attrName: string; attrValue: string; keepAttr: boolean }) {
  if (node.hasAttribute("data-resource-reference")) return
  const carriers = referenceCarriers[node.nodeName.toLowerCase()]
  if (!carriers?.includes(data.attrName)) return
  const chosen = carriers.find((attribute) => carrierReference(node, attribute) !== undefined)
  const value = chosen ? carrierReference(node, chosen) : undefined
  if (!chosen || !value) return
  if (chosen !== data.attrName) {
    if (carrierReference(node, data.attrName) !== undefined) data.keepAttr = false
    return
  }
  if (data.attrName !== "src" && data.attrName !== "href") node.setAttribute("data-resource-attribute", data.attrName)
  node.setAttribute("data-resource-reference", normalizeScheme(value))
  data.keepAttr = false
}

/** `<iframe>`, `<object>` and `<embed>` would lose an embedded managed document
 *  entirely. Swap the frame for an inert reference carrier before removal so the
 *  observer can still render and open it; a frame pointing anywhere else is
 *  removed as before. */
function referenceFrame(node: Node) {
  if (node.nodeType !== 1) return
  const element = node as Element
  if (!referenceFrames.has(element.nodeName.toLowerCase())) return
  const value = element.getAttribute("src") ?? element.getAttribute("data")
  if (!value) return
  const reference = managedReference(value)
  if (!reference) return
  const carrier = element.ownerDocument.createElement("span")
  carrier.setAttribute("data-resource-reference", normalizeScheme(value))
  carrier.setAttribute("data-slot", "markdown-resource-frame")
  element.replaceWith(carrier)
}

// An isolated instance keeps these hooks off the shared DOMPurify singleton that
// HTML file previews and plugin documents sanitize with.
type Purifier = typeof DOMPurify
const createPurifier = DOMPurify as unknown as (window?: Window) => Purifier
let bound: { window: Window; purifier: Purifier } | undefined

function purifier(window: Window) {
  if (bound?.window === window) return bound.purifier
  const created = createPurifier(window)
  created.addHook("uponSanitizeAttribute", referenceAttribute)
  created.addHook("uponSanitizeElement", referenceFrame)
  bound = { window, purifier: created }
  return created
}

export function sanitizeHtml(html: string): string {
  if (typeof window === "undefined") return html
  return purifier(window).sanitize(html, {
    ADD_TAGS: ["semantics", "annotation"],
    ADD_ATTR: ["target", "encoding"],
    FORBID_TAGS: ["style"],
  })
}
