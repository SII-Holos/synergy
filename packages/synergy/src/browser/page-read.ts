export namespace BrowserPageRead {
  /** Cut HTML to maxBytes (byte-safe), appending a truncation marker. */
  export function truncateHTML(html: string, maxBytes: number): string {
    if (maxBytes <= 0) return ""
    const buf = Buffer.from(html)
    if (buf.length <= maxBytes) return html

    const diffKB = Math.max(1, Math.round((buf.length - maxBytes) / 1024))
    const marker = `... [truncated ${diffKB} KB]`
    const markerBytes = Buffer.from(marker).length
    const targetBytes = maxBytes - markerBytes
    if (targetBytes <= 0) return ""

    let cut = targetBytes
    while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--

    return buf.slice(0, cut).toString() + marker
  }

  /** Remove HTML tags, script/style blocks, decode entities, collapse space. */
  export function stripHTMLTags(text: string): string {
    if (!text) return ""

    let result = text
    // Remove script and style blocks (including content)
    result = result.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    result = result.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")

    // Remove all remaining HTML tags
    result = result.replace(/<[^>]*>/g, "")

    // Decode HTML entities
    result = result.replace(/&amp;/g, "&")
    result = result.replace(/&lt;/g, "<")
    result = result.replace(/&gt;/g, ">")
    result = result.replace(/&quot;/g, '"')
    result = result.replace(/&#39;/g, "'")

    // Collapse whitespace and trim
    result = result.replace(/\s+/g, " ").trim()

    return result
  }

  /** Check if element attributes indicate a password field. */
  export function isPasswordField(attributes: Record<string, string>): boolean {
    if (!attributes) return false
    const type = attributes.type?.toLowerCase()
    if (type === "password") return true
    const autocomplete = attributes.autocomplete?.toLowerCase()
    if (autocomplete === "current-password" || autocomplete === "new-password") return true
    if (attributes.name && /password/i.test(attributes.name)) return true
    return false
  }

  /** Check if element is visible based on style, bounds, and viewport. */
  export function isVisibleElement(
    style: Record<string, string>,
    bounds: { x: number; y: number; width: number; height: number },
    viewportW: number,
    viewportH: number,
  ): boolean {
    if (style.display === "none") return false
    if (style.visibility === "hidden") return false
    if (style.opacity === "0") return false
    if (!bounds.width || !bounds.height) return false

    return bounds.x + bounds.width > 0 && bounds.y + bounds.height > 0 && bounds.x < viewportW && bounds.y < viewportH
  }

  /** Truncate a DOM snapshot string to maxBytes (default 64 KB). */
  export function domSnapshot(html: string, maxBytes?: number): string {
    return truncateHTML(html, maxBytes ?? 65536)
  }

  /** Convert HTML to trimmed plain text, optionally excluding hidden elements. */
  export function pageText(html: string, options?: { visibleOnly?: boolean }): string {
    if (!html) return ""

    let processed = html

    if (options?.visibleOnly) {
      // Remove elements with display:none
      processed = processed.replace(
        /<[^>]*style\s*=\s*["'][^"']*display\s*:\s*none[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/gi,
        "",
      )
      // Remove elements with visibility:hidden
      processed = processed.replace(
        /<[^>]*style\s*=\s*["'][^"']*visibility\s*:\s*hidden[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/gi,
        "",
      )
    }

    return stripHTMLTags(processed)
  }

  /** Select requested attributes from an element, stripping sensitive values. */
  export function elementAttributes(
    element: { attributes?: Record<string, string> },
    requested: string[],
  ): Record<string, string> {
    const attrs = element.attributes
    if (!attrs || requested.length === 0) return {}

    const sensitive = attrs.type === "password" || attrs.type === "hidden" || isPasswordField(attrs)

    const result: Record<string, string> = {}
    for (const key of requested) {
      if (!(key in attrs)) continue
      if (key === "value" && sensitive) continue
      result[key] = attrs[key]
    }

    return result
  }

  /** Select requested computed style properties from an element. */
  export function computedStyle(
    element: { computedStyles?: Record<string, string> },
    requested: string[],
  ): Record<string, string> {
    const styles = element.computedStyles
    if (!styles || requested.length === 0) return {}

    const result: Record<string, string> = {}
    for (const key of requested) {
      if (key in styles) {
        result[key] = styles[key]
      }
    }

    return result
  }

  /** Filter elements to only those visible in the viewport. */
  export function visibleDOM<
    T extends {
      style: Record<string, string>
      bounds: { x: number; y: number; width: number; height: number }
    },
  >(elements: T[], viewportW: number, viewportH: number): T[] {
    return elements.filter((el) => isVisibleElement(el.style, el.bounds, viewportW, viewportH))
  }
}

// Re-export at module level for direct imports used by tests
export const {
  truncateHTML,
  stripHTMLTags,
  isPasswordField,
  isVisibleElement,
  domSnapshot,
  pageText,
  elementAttributes,
  computedStyle,
  visibleDOM,
} = BrowserPageRead
