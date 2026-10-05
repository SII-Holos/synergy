import DOMPurify from "dompurify"
import { createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { THEME_CHANGE_EVENT } from "../theme/application"
import { synergyTheme } from "../theme/default-themes"
import { resolveTheme, resolveThemeColor } from "../theme/resolve"
import type { ResolvedTheme } from "../theme/types"

const MIN_HEIGHT = 48
const DEFAULT_HEIGHT = 80
const MAX_HEIGHT = 720

export const RENDER_HTML_CSP = [
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

function selectRenderThemeColors(tokens: ResolvedTheme) {
  return Object.fromEntries(THEME_VARIABLES.map((name) => [name, resolveThemeColor(tokens, name)])) as Record<
    (typeof THEME_VARIABLES)[number],
    string
  >
}

const DEFAULT_THEME = resolveTheme(synergyTheme)
const RENDER_FALLBACK_THEMES = {
  light: selectRenderThemeColors(DEFAULT_THEME.light),
  dark: selectRenderThemeColors(DEFAULT_THEME.dark),
} as const

const BASE_STYLE = `
  * { box-sizing: border-box; }

  html {
    margin: 0;
    background: transparent;
    color-scheme: var(--render-color-scheme, light);
  }

  body {
    margin: 0;
    display: flow-root;
    padding: 16px;
    background: transparent;
    color: var(--render-text-base);
    font-family: var(--render-font-family-sans, Inter, ui-sans-serif, system-ui, sans-serif);
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
    font-family: var(--render-font-family-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
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

  body[data-synergy-render-fullbleed] { padding: 0; }
`

function readThemeCss() {
  if (typeof window === "undefined") return fallbackThemeCss("light")

  const root = document.documentElement
  const computed = window.getComputedStyle(root)
  const mode = root.dataset.colorScheme === "dark" ? "dark" : "light"
  const fallback = RENDER_FALLBACK_THEMES[mode]
  const sans = computed.getPropertyValue("--font-family-sans").trim() || '"Inter", sans-serif'
  const mono = computed.getPropertyValue("--font-family-mono").trim() || '"IBM Plex Mono", monospace'
  const lines = [
    `--render-color-scheme: ${mode};`,
    `--render-font-family-sans: ${sans};`,
    `--render-font-family-mono: ${mono};`,
  ]

  for (const name of THEME_VARIABLES) {
    const value = computed.getPropertyValue(`--${name}`).trim() || fallback[name]
    lines.push(`--render-${name}: ${value};`)
  }

  return `:root {\n${lines.map((line) => `  ${line}`).join("\n")}\n}`
}

function fallbackThemeCss(mode: "light" | "dark") {
  const fallback = RENDER_FALLBACK_THEMES[mode]
  const lines = [
    `--render-color-scheme: ${mode};`,
    '--render-font-family-sans: "Inter", sans-serif;',
    '--render-font-family-mono: "IBM Plex Mono", monospace;',
  ]
  for (const name of THEME_VARIABLES) lines.push(`--render-${name}: ${fallback[name]};`)
  return `:root {\n${lines.map((line) => `  ${line}`).join("\n")}\n}`
}

export function renderHtmlDocument(html: string, themeCss: string) {
  const csp = `<meta http-equiv="Content-Security-Policy" content="${RENDER_HTML_CSP}">`
  const root = DOMPurify.sanitize(`<!doctype html><html><head>${csp}</head><body>${html}</body></html>`, {
    WHOLE_DOCUMENT: true,
    RETURN_DOM: true,
    ADD_TAGS: ["use"],
    FORBID_TAGS: [
      "base",
      "meta",
      "link",
      "form",
      "iframe",
      "object",
      "embed",
      "set",
      "animate",
      "animateMotion",
      "animateTransform",
    ],
    FORBID_ATTR: ["srcdoc", "autofocus"],
  })
  if (!(root instanceof window.HTMLElement)) throw new Error("Render HTML requires a browser document")
  for (const element of root.querySelectorAll("*")) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith("data-synergy-render-")) element.removeAttribute(attribute.name)
      if (
        element.localName === "a" ||
        element.localName === "area" ||
        element.namespaceURI === "http://www.w3.org/1998/Math/MathML"
      ) {
        if (["href", "xlink:href", "ping", "target", "download"].includes(name)) element.removeAttribute(attribute.name)
      } else if (
        element.localName === "use" &&
        (name === "href" || name === "xlink:href") &&
        !attribute.value.startsWith("#")
      ) {
        element.removeAttribute(attribute.name)
      }
    }
  }
  const head = root.querySelector("head")!
  const body = root.querySelector("body")!
  const contentRoots = Array.from(body.children).filter((element) => element.localName !== "style")
  if (contentRoots.length === 1 && contentRoots[0].hasAttribute("data-render-fullbleed"))
    body.dataset.synergyRenderFullbleed = ""
  const policy = root.ownerDocument.createElement("meta")
  policy.httpEquiv = "Content-Security-Policy"
  policy.content = RENDER_HTML_CSP
  const base = root.ownerDocument.createElement("style")
  base.dataset.synergyRenderBase = ""
  base.textContent = BASE_STYLE
  const theme = root.ownerDocument.createElement("style")
  theme.dataset.synergyRenderTheme = ""
  theme.textContent = themeCss
  head.prepend(policy, base, theme)
  return `<!doctype html>${root.outerHTML}`
}

export function RenderHtml(props: {
  html: string
  title?: string
  expanded?: boolean
  maxHeight?: number
  onEscape?: () => void
}) {
  const [contentHeight, setContentHeight] = createSignal(DEFAULT_HEIGHT)
  const srcdoc = createMemo(() => renderHtmlDocument(props.html, readThemeCss()))
  let iframeRef: HTMLIFrameElement | undefined
  let observer: ResizeObserver | undefined
  let timers: number[] = []
  let measureFrame: number | undefined
  let themeStyle: HTMLStyleElement | undefined
  let releaseDocument: (() => void) | undefined

  const measure = () => {
    const doc = iframeRef?.contentDocument
    const body = doc?.body
    if (!body) return

    const limit = props.expanded ? Math.max(160, window.innerHeight - 180) : (props.maxHeight ?? MAX_HEIGHT)
    const nextHeight = Math.max(body.offsetHeight, body.scrollHeight, MIN_HEIGHT)
    setContentHeight(Math.min(nextHeight, limit))
  }

  const scheduleMeasure = () => {
    if (measureFrame !== undefined) cancelAnimationFrame(measureFrame)
    measureFrame = requestAnimationFrame(() => {
      measureFrame = undefined
      measure()
    })
  }

  const updateTheme = () => {
    if (themeStyle && themeStyle.ownerDocument === iframeRef?.contentDocument) themeStyle.textContent = readThemeCss()
    scheduleMeasure()
  }
  const clearTimers = () => {
    for (const timer of timers) window.clearTimeout(timer)
    timers = []
  }

  const onLoad = () => {
    observer?.disconnect()
    clearTimers()
    releaseDocument?.()
    releaseDocument = undefined
    themeStyle = undefined

    const doc = iframeRef?.contentDocument
    if (doc?.body && doc.URL === "about:srcdoc") {
      themeStyle = doc.head.querySelector<HTMLStyleElement>("style[data-synergy-render-theme]") ?? undefined
      if (themeStyle) themeStyle.textContent = readThemeCss()
      const blockNavigation = (event: Event) => {
        if (
          event.composedPath().some((node) => {
            const element = node as Element
            return (
              ["a", "area"].includes(element.localName) ||
              (element.namespaceURI === "http://www.w3.org/1998/Math/MathML" &&
                (element.hasAttribute("href") || element.hasAttribute("xlink:href")))
            )
          })
        )
          event.preventDefault()
      }
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key !== "Escape" || event.defaultPrevented || !props.onEscape) return
        event.preventDefault()
        props.onEscape()
      }
      doc.addEventListener("click", blockNavigation, true)
      doc.addEventListener("auxclick", blockNavigation, true)
      doc.addEventListener("keydown", handleKeyDown)
      releaseDocument = () => {
        doc.removeEventListener("click", blockNavigation, true)
        doc.removeEventListener("auxclick", blockNavigation, true)
        doc.removeEventListener("keydown", handleKeyDown)
      }
      observer = new ResizeObserver(scheduleMeasure)
      observer.observe(doc.body)
    }

    measure()
    scheduleMeasure()
    timers = [window.setTimeout(measure, 100), window.setTimeout(measure, 500)]
  }

  onMount(() => {
    document.addEventListener(THEME_CHANGE_EVENT, updateTheme)
    document.addEventListener("synergy:font-change", updateTheme)
    window.addEventListener("resize", scheduleMeasure)
    onCleanup(() => {
      document.removeEventListener(THEME_CHANGE_EVENT, updateTheme)
      document.removeEventListener("synergy:font-change", updateTheme)
      window.removeEventListener("resize", scheduleMeasure)
    })
  })

  onCleanup(() => {
    observer?.disconnect()
    releaseDocument?.()
    clearTimers()
    if (measureFrame !== undefined) cancelAnimationFrame(measureFrame)
  })

  return (
    <div data-component="render-html" style={{ overflow: "hidden" }}>
      <iframe
        ref={iframeRef}
        title={props.title}
        srcdoc={srcdoc()}
        sandbox="allow-same-origin"
        onLoad={onLoad}
        style={{
          width: "100%",
          height: `${contentHeight()}px`,
          border: "none",
          overflow: "hidden",
          display: "block",
          background: "transparent",
        }}
      />
    </div>
  )
}
