import { createMemo, createSignal, onCleanup, onMount } from "solid-js"

const MIN_HEIGHT = 120
const DEFAULT_HEIGHT = 280
const MAX_HEIGHT = 720

const CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ")

const THEME_VARIABLES = [
  "background-base",
  "surface-base",
  "surface-raised-base",
  "surface-raised-stronger-non-alpha",
  "surface-inset-base",
  "surface-brand-base",
  "surface-interactive-base",
  "surface-success-strong",
  "surface-warning-strong",
  "surface-critical-strong",
  "text-base",
  "text-weak",
  "text-weaker",
  "text-strong",
  "text-interactive-base",
  "border-base",
  "border-weak-base",
  "border-strong-base",
] as const

const FALLBACK_THEME: Record<(typeof THEME_VARIABLES)[number], string> = {
  "background-base": "#f8f7f7",
  "surface-base": "rgba(5, 0, 0, 0.04)",
  "surface-raised-base": "rgba(255, 255, 255, 0.72)",
  "surface-raised-stronger-non-alpha": "#ffffff",
  "surface-inset-base": "rgba(5, 0, 0, 0.04)",
  "surface-brand-base": "#b98522",
  "surface-interactive-base": "#4f67c8",
  "surface-success-strong": "#218a62",
  "surface-warning-strong": "#9b671a",
  "surface-critical-strong": "#914f39",
  "text-base": "#332e2b",
  "text-weak": "#6f6761",
  "text-weaker": "#8b817a",
  "text-strong": "#1f1a17",
  "text-interactive-base": "#4f67c8",
  "border-base": "rgba(31, 0, 0, 0.16)",
  "border-weak-base": "rgba(31, 0, 0, 0.1)",
  "border-strong-base": "rgba(31, 0, 0, 0.22)",
}

const BASE_STYLE = `
  * { box-sizing: border-box; }

  html {
    margin: 0;
    min-height: 100%;
    background: transparent;
    color-scheme: var(--render-color-scheme, light);
  }

  body {
    margin: 0;
    min-height: 100%;
    padding: 16px;
    background: transparent;
    color: var(--render-text-base);
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 13px;
    line-height: 1.55;
    overflow: auto;
    overflow-wrap: anywhere;
  }

  h1, h2, h3, h4 {
    margin: 0 0 0.72em;
    color: var(--render-text-strong);
    line-height: 1.18;
    letter-spacing: -0.018em;
    font-weight: 650;
  }

  h1 { font-size: 22px; }
  h2 { font-size: 17px; }
  h3 { font-size: 14px; }
  h4 { font-size: 13px; }

  p {
    margin: 0 0 0.8em;
    color: var(--render-text-weak);
  }

  p:last-child { margin-bottom: 0; }

  a {
    color: var(--render-text-interactive-base);
    text-decoration: none;
  }

  a:hover { text-decoration: underline; }

  table {
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    overflow: hidden;
    border-radius: 10px;
    background: color-mix(in srgb, var(--render-surface-raised-base) 72%, transparent);
    border: 1px solid var(--render-border-weak-base);
  }

  th, td {
    padding: 9px 11px;
    border-bottom: 1px solid var(--render-border-weak-base);
    text-align: left;
    vertical-align: top;
  }

  th {
    color: var(--render-text-weak);
    background: color-mix(in srgb, var(--render-surface-brand-base) 10%, transparent);
    font-size: 11px;
    font-weight: 650;
    letter-spacing: 0.035em;
    text-transform: uppercase;
  }

  tr:last-child td { border-bottom: 0; }

  code {
    padding: 0.12em 0.35em;
    border-radius: 5px;
    background: var(--render-surface-inset-base);
    color: var(--render-text-strong);
    border: 1px solid var(--render-border-weak-base);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.94em;
  }

  pre {
    margin: 0.9em 0;
    padding: 12px;
    overflow: auto;
    border-radius: 10px;
    background: var(--render-surface-inset-base);
    border: 1px solid var(--render-border-weak-base);
  }

  pre code {
    padding: 0;
    border: 0;
    background: transparent;
  }

  blockquote {
    margin: 0.9em 0;
    padding: 0.1em 0 0.1em 1em;
    color: var(--render-text-weak);
    border-left: 2px solid var(--render-border-strong-base);
  }

  ul, ol { padding-left: 1.4em; }
  li { margin: 0.2em 0; }
  svg { max-width: 100%; height: auto; }

  .card, .panel, [data-render-card] {
    border-radius: 14px;
    border: 1px solid var(--render-border-weak-base);
    background: color-mix(in srgb, var(--render-surface-raised-base) 78%, transparent);
    padding: 14px;
  }

  [data-render-fullbleed] {
    margin: -16px;
  }
`

function readThemeCss() {
  if (typeof window === "undefined") return fallbackThemeCss("light")

  const root = document.documentElement
  const computed = window.getComputedStyle(root)
  const mode = root.dataset.colorScheme === "dark" ? "dark" : "light"
  const lines = [`--render-color-scheme: ${mode};`]

  for (const name of THEME_VARIABLES) {
    const value = computed.getPropertyValue(`--${name}`).trim() || FALLBACK_THEME[name]
    lines.push(`--render-${name}: ${value};`)
  }

  return `:root {\n${lines.map((line) => `  ${line}`).join("\n")}\n}`
}

function fallbackThemeCss(mode: "light" | "dark") {
  const lines = [`--render-color-scheme: ${mode};`]
  for (const name of THEME_VARIABLES) lines.push(`--render-${name}: ${FALLBACK_THEME[name]};`)
  return `:root {\n${lines.map((line) => `  ${line}`).join("\n")}\n}`
}

function wrapHtml(html: string, themeCss: string) {
  const csp = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`
  const base = `<style data-synergy-render-base>\n${themeCss}\n${BASE_STYLE}\n</style>`
  const headContent = `${csp}\n${base}`

  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>\n${headContent}`)
  }

  if (/<html[\s>]/i.test(html)) {
    return html.replace(/<html([^>]*)>/i, `<html$1>\n<head>\n${headContent}\n</head>`)
  }

  return `<!doctype html>
<html>
<head>
${headContent}
</head>
<body>
${html}
</body>
</html>`
}

export function RenderHtml(props: { html: string }) {
  const [contentHeight, setContentHeight] = createSignal(DEFAULT_HEIGHT)
  const [themeVersion, setThemeVersion] = createSignal(0)
  const srcdoc = createMemo(() => {
    themeVersion()
    return wrapHtml(props.html, readThemeCss())
  })
  let iframeRef: HTMLIFrameElement | undefined
  let observer: ResizeObserver | undefined
  let rootObserver: MutationObserver | undefined
  let timers: number[] = []

  const measure = () => {
    const doc = iframeRef?.contentDocument
    const body = doc?.body
    const root = doc?.documentElement
    if (!body || !root) return

    const nextHeight = Math.max(body.scrollHeight, root.scrollHeight, body.offsetHeight, root.offsetHeight, MIN_HEIGHT)
    setContentHeight(Math.min(nextHeight, MAX_HEIGHT))
  }

  const clearTimers = () => {
    for (const timer of timers) window.clearTimeout(timer)
    timers = []
  }

  const onLoad = () => {
    observer?.disconnect()
    clearTimers()

    const doc = iframeRef?.contentDocument
    if (doc?.body) {
      observer = new ResizeObserver(measure)
      observer.observe(doc.body)
      if (doc.documentElement) observer.observe(doc.documentElement)
    }

    measure()
    requestAnimationFrame(measure)
    timers = [window.setTimeout(measure, 100), window.setTimeout(measure, 500)]
  }

  onMount(() => {
    rootObserver = new MutationObserver(() => setThemeVersion((version) => version + 1))
    rootObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-color-scheme", "class", "style"],
    })
  })

  onCleanup(() => {
    observer?.disconnect()
    rootObserver?.disconnect()
    clearTimers()
  })

  return (
    <div data-component="render-html" style={{ overflow: "hidden" }}>
      <iframe
        ref={iframeRef}
        srcdoc={srcdoc()}
        sandbox="allow-same-origin"
        onLoad={onLoad}
        style={{
          width: "100%",
          height: `${contentHeight()}px`,
          "max-height": `${MAX_HEIGHT}px`,
          border: "none",
          overflow: "hidden",
          display: "block",
          background: "transparent",
        }}
      />
    </div>
  )
}
