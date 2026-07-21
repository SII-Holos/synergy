export type MarkdownRenderEntry = {
  hash: string
  html: string
}

export function markdownRenderHash(value: string) {
  let hash = 5381
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 33) ^ value.charCodeAt(i)
  }
  return (hash >>> 0).toString(36)
}

export function escapeMarkdownFallbackHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

export function markdownFallbackHtml(markdown: string) {
  return `<pre data-slot="markdown-render-fallback"><code>${escapeMarkdownFallbackHtml(markdown)}</code></pre>`
}

export function markdownRenderEntry(markdown: string, html: string): MarkdownRenderEntry {
  return { hash: markdownRenderHash(markdown), html }
}

export function isCurrentMarkdownRender(rendered: MarkdownRenderEntry | null | undefined, markdown: string) {
  return rendered?.hash === markdownRenderHash(markdown)
}
