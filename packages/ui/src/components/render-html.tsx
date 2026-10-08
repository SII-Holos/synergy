import DOMPurify from "dompurify"
import { createEffect, createMemo, createResource, createSignal, onCleanup, onMount, Show, untrack } from "solid-js"
import { useLingui } from "@lingui/solid"
import { RenderArtifact } from "@ericsanchezok/synergy-util/render-artifact"
import { generateSecureUUID } from "@ericsanchezok/synergy-util/uuid"
import { FrameMessage, type HostContext, type RuntimeConfig } from "./render/protocol"
import { renderRuntime } from "./render/runtime"
import { installRenderControls } from "./render/controls"
import { captureRenderElement } from "./render/capture"
import { loadRenderLibraries } from "./render/libraries"
import { loadRenderFonts } from "./render/fonts"
import { localizeRenderLabels, renderLabels } from "./render/labels"
import { Button } from "./button"
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
  "chart-series-1",
  "chart-series-2",
  "chart-series-3",
  "chart-series-4",
  "chart-series-5",
  "chart-series-6",
  "chart-series-7",
  "chart-series-8",
  "chart-series-9",
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

export const BASE_STYLE = `
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
  input, select, button, textarea { font: inherit; color: inherit; accent-color: var(--render-text-interactive-base); }
  button, select { border: 1px solid var(--render-border-base); border-radius: 6px; padding: 6px 10px; background: var(--render-surface-base); }
  button { cursor: pointer; }
  button:disabled { opacity: .55; cursor: default; }
  :focus-visible { outline: 2px solid var(--render-text-interactive-base); outline-offset: 2px; }
  [hidden] { display: none !important; }
  [data-render-controls] { margin-top: 16px; padding: 12px 16px; border-top: 1px solid var(--render-border-weak-base); }
  [data-render-controls] fieldset { margin: 0 0 12px; padding: 0; border: 0; min-width: 0; }
  [data-render-controls] legend { margin-bottom: 8px; font-weight: 600; }
  [data-render-control] { display: grid; grid-template-columns: minmax(90px, 1fr) minmax(80px, 2fr) auto; align-items: center; gap: 12px; margin: 8px 0; }
  [data-render-control] input, [data-render-control] select { min-width: 0; max-width: 100%; }
  [data-render-control] output { min-width: 3ch; font-variant-numeric: tabular-nums; }
  [data-render-actions], [data-render-variants] { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  [data-render-variants] { margin: 0 0 16px; }
  [data-render-variants] [aria-pressed=true] { background: var(--render-surface-interactive-base); }
  [data-render-feedback=true] [data-render-annotation]:hover { outline: 2px solid var(--render-text-interactive-base); cursor: crosshair; }
  [data-render-calendar-grid] { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 4px; margin-top: 12px; }
  [data-render-calendar-grid] > div { min-height: 60px; min-width: 0; padding: 4px; border: 1px solid var(--render-border-weak-base); }
  [data-render-calendar-grid] button { display: block; width: 100%; padding: 4px; overflow-wrap: anywhere; text-align: left; font-size: 12px; }
  [data-render-active=false] *, [data-render-reduced-motion=true] * { animation-play-state: paused !important; }
  [data-render-reduced-motion=true] *, [data-render-reduced-motion=true] *::before, [data-render-reduced-motion=true] *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }

`

export function readThemeCss() {
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

export function renderHtmlDocument(html: string, themeCss: string, runtime?: RuntimeConfig, libraries: string[] = []) {
  const csp = `<meta http-equiv="Content-Security-Policy" content="${RENDER_HTML_CSP}">`
  const root = runtime?.interactive
    ? new DOMParser().parseFromString(html, "text/html").documentElement
    : DOMPurify.sanitize(`<!doctype html><html><head>${csp}</head><body>${html}</body></html>`, {
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
  for (const element of root.querySelectorAll("base, meta, iframe, object, embed")) element.remove()
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
  policy.content = runtime?.interactive
    ? "default-src 'none'; script-src 'unsafe-inline' https: blob:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
    : runtime
      ? RENDER_HTML_CSP.replace("script-src 'none'", `script-src 'nonce-${runtime.nonce}'`)
      : RENDER_HTML_CSP
  const base = root.ownerDocument.createElement("style")
  base.dataset.synergyRenderBase = ""
  base.textContent = BASE_STYLE
  const theme = root.ownerDocument.createElement("style")
  theme.dataset.synergyRenderTheme = ""
  theme.textContent = themeCss
  const scripts: HTMLScriptElement[] = []
  if (runtime) {
    const bootstrap = root.ownerDocument.createElement("script")
    bootstrap.dataset.synergyRenderBootstrap = ""
    const safeJSON = JSON.stringify(runtime).replaceAll("<", "\\u003c")
    bootstrap.textContent = `(${renderRuntime.toString()})(${safeJSON}, (${installRenderControls.toString()}), (${captureRenderElement.toString()}));`
    scripts.push(bootstrap)
    for (const code of libraries) {
      const script = root.ownerDocument.createElement("script")
      script.textContent = code.replace(/<\/script/gi, "<\\/script")
      scripts.push(script)
    }
  }
  head.prepend(policy, base, theme, ...scripts)
  const serialized = root.outerHTML
  return `<!doctype html>${runtime ? serialized.replace('data-synergy-render-bootstrap=""', `nonce="${runtime.nonce}"`) : serialized}`
}

export function readHostContext(locale: string, width: number, expanded = false, active = true): HostContext {
  const css = readThemeCss()
  const theme: Record<string, string> = {}
  for (const match of css.matchAll(/--render-([\w-]+):\s*([^;]+);/g)) theme[match[1]] = match[2]
  const computed = window.getComputedStyle(document.documentElement)
  for (const name of [
    "motion-duration-fast",
    "motion-duration-base",
    "motion-duration-slow",
    "motion-ease-standard",
    "motion-ease-emphasized",
  ])
    theme[name] = computed.getPropertyValue(`--${name}`).trim()
  return {
    theme,
    locale,
    width,
    colorScheme: theme["color-scheme"] === "dark" ? "dark" : "light",
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    viewMode: expanded ? "expanded" : "inline",
    active,
  }
}

export function RenderHtml(props: {
  html: string
  source?: RenderArtifact.Source
  state?: RenderArtifact.State
  title?: string
  expanded?: boolean
  active?: boolean
  feedback?: boolean
  maxHeight?: number
  onEscape?: () => void
  onReady?: (flush: () => Promise<void>) => void
  onState?: (content: RenderArtifact.Content, requestID: string, revision: number) => Promise<RenderArtifact.State>
  onFollowUp?: (input: RenderArtifact.FollowUp) => Promise<unknown>
}) {
  const { _, i18n } = useLingui()
  const [contentHeight, setContentHeight] = createSignal(DEFAULT_HEIGHT)
  const [failure, setFailure] = createSignal<string>()
  const [attempt, setAttempt] = createSignal(0)
  const [visible, setVisible] = createSignal(true)
  let iframe: HTMLIFrameElement | undefined
  const [frame, setFrame] = createSignal<HTMLIFrameElement>()
  let port: MessagePort | undefined
  let loaded = false
  let revoked = false
  let deadline: number | undefined
  let pending = 0
  const flushes = new Map<string, { resolve(): void; reject(error: Error): void; timer: number }>()
  const nonce = createMemo(() => {
    attempt()
    props.html
    props.source?.id
    return generateSecureUUID()
  })
  const [libraries] = createResource(
    () => {
      attempt()
      return props.source?.libraries ?? []
    },
    async (libraries) => {
      const [scripts, fonts] = await Promise.all([loadRenderLibraries(libraries), loadRenderFonts()])
      return { scripts, fonts }
    },
  )
  const context = () =>
    readHostContext(
      i18n().locale,
      iframe?.clientWidth ?? 0,
      props.expanded,
      props.active !== false && visible() && !document.hidden,
    )
  const config = (): RuntimeConfig => ({
    nonce: nonce(),
    version: props.source?.id ?? "static",
    interactive: props.source?.mode === "interactive",
    offline: false,
    revision: props.state?.revision ?? 0,
    context: context(),
    state: props.state?.content ?? {},
    labels: localizeRenderLabels(_),
  })
  const srcdoc = createMemo(() => {
    const code = libraries.error || libraries.loading ? undefined : libraries()
    if (!code) return undefined
    return renderHtmlDocument(props.html, code.fonts + untrack(readThemeCss), untrack(config), code.scripts)
  })
  function disconnect() {
    clearTimeout(deadline)
    port?.postMessage({ type: "dispose" })
    port?.close()
    port = undefined
    pending = 0
    for (const flush of flushes.values()) {
      clearTimeout(flush.timer)
      flush.reject(new Error(_(renderLabels.closed)))
    }
    flushes.clear()
  }
  const updateContext = () =>
    port?.postMessage({ type: "context", context: context(), labels: localizeRenderLabels(_) })
  async function handle(channel: MessagePort, data: unknown) {
    if (channel !== port) return
    let parsed: ReturnType<typeof FrameMessage.safeParse>
    try {
      if (new TextEncoder().encode(JSON.stringify(data)).byteLength > RenderArtifact.IMAGE_URL_LIMIT + 36 * 1024) return
      parsed = FrameMessage.safeParse(data)
    } catch {
      return
    }
    if (!parsed.success) {
      if (
        data &&
        typeof data === "object" &&
        "requestID" in data &&
        typeof data.requestID === "string" &&
        data.requestID.length <= 100
      )
        channel.postMessage({
          type: "response",
          requestID: data.requestID,
          ok: false,
          error: _(renderLabels.invalidRequest),
        })
      return
    }
    const message = parsed.data
    if (message.type === "flushed") {
      const flush = flushes.get(message.requestID)
      if (flush) {
        clearTimeout(flush.timer)
        flushes.delete(message.requestID)
        if (message.error) flush.reject(new Error(message.error))
        else flush.resolve()
      }
      return
    }
    if (message.type === "resize") {
      setContentHeight(Math.max(MIN_HEIGHT, message.height))
      return
    }
    if (message.type === "escape") {
      props.onEscape?.()
      return
    }
    if (message.type === "error") {
      setFailure(message.message)
      return
    }
    const respond = (ok: boolean, value?: unknown, error?: string) => {
      if (port === channel) channel.postMessage({ type: "response", requestID: message.requestID, ok, value, error })
    }
    if (props.source?.mode !== "interactive" || props.active === false) {
      respond(false, undefined, _(renderLabels.closed))
      return
    }
    if (pending >= 4) {
      respond(false, undefined, _(renderLabels.busy))
      return
    }
    pending++
    try {
      if (message.type === "state") {
        if (!props.onState) throw new Error(_(renderLabels.unavailable))
        const state = await props.onState(message.content, message.requestID, message.revision)
        respond(true, state)
      } else {
        if (!props.onFollowUp) throw new Error(_(renderLabels.unavailable))
        const { type: messageType, ...request } = message
        respond(true, await props.onFollowUp(request))
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      setFailure(reason)
      respond(false, undefined, reason)
    } finally {
      if (port === channel) pending--
    }
  }
  createEffect(() => {
    const document = srcdoc()
    disconnect()
    loaded = false
    revoked = false
    setFailure(undefined)
    if (document) deadline = window.setTimeout(() => setFailure(_(renderLabels.timeout)), 15000)
  })
  createEffect(() => {
    props.state
    port?.postMessage({ type: "state", state: props.state ?? RenderArtifact.emptyState() })
  })
  createEffect(() => {
    props.active
    visible()
    i18n().locale
    updateContext()
  })
  createEffect(() => {
    const active = props.feedback ?? false
    port?.postMessage({ type: "feedback", active })
  })
  onMount(() => {
    const connect = (event: MessageEvent) => {
      if (
        event.source !== iframe?.contentWindow ||
        event.data?.type !== "synergy.render.ready" ||
        event.data.nonce !== nonce() ||
        port ||
        revoked
      )
        return
      const channel = new MessageChannel()
      port = channel.port1
      port.onmessage = (event) => {
        void handle(channel.port1, event.data)
      }
      port.start()
      iframe.contentWindow!.postMessage({ type: "synergy.render.connect", nonce: nonce() }, "*", [channel.port2])
      clearTimeout(deadline)
      props.onReady?.(
        () =>
          new Promise<void>((resolve, reject) => {
            if (port !== channel.port1) {
              reject(new Error(_(renderLabels.closed)))
              return
            }
            const requestID = generateSecureUUID()
            const timer = window.setTimeout(() => {
              flushes.delete(requestID)
              reject(new Error(_(renderLabels.timeout)))
            }, 10000)
            flushes.set(requestID, { resolve, reject, timer })
            port.postMessage({ type: "flush", requestID })
          }),
      )
      updateContext()
      port.postMessage({ type: "feedback", active: props.feedback ?? false })
    }
    window.addEventListener("message", connect)
    document.addEventListener(THEME_CHANGE_EVENT, updateContext)
    document.addEventListener("synergy:font-change", updateContext)
    document.addEventListener("visibilitychange", updateContext)
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)")
    reduced.addEventListener("change", updateContext)
    onCleanup(() => {
      disconnect()
      window.removeEventListener("message", connect)
      document.removeEventListener(THEME_CHANGE_EVENT, updateContext)
      document.removeEventListener("synergy:font-change", updateContext)
      document.removeEventListener("visibilitychange", updateContext)
      reduced.removeEventListener("change", updateContext)
    })
  })
  createEffect(() => {
    const element = frame()
    if (!element) return
    const resize = new ResizeObserver(updateContext)
    const intersection = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      rootMargin: "160px",
    })
    resize.observe(element)
    intersection.observe(element)
    onCleanup(() => {
      resize.disconnect()
      intersection.disconnect()
    })
  })
  return (
    <div data-component="render-html" data-expanded={props.expanded ?? false}>
      <Show when={failure() || libraries.error}>
        {(message) => (
          <div data-slot="render-error" role="alert">
            <span>{String(message())}</span>
            <Button size="small" variant="ghost" onClick={() => setAttempt((value) => value + 1)}>
              {_(renderLabels.retry)}
            </Button>
          </div>
        )}
      </Show>
      <Show when={srcdoc()}>
        <iframe
          ref={(element) => {
            iframe = element
            setFrame(element)
            element.setAttribute("credentialless", "")
          }}
          title={props.title}
          srcdoc={srcdoc()}
          sandbox="allow-scripts"
          referrerpolicy="no-referrer"
          allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'"
          onLoad={() => {
            if (loaded) {
              revoked = true
              disconnect()
              setFailure(_(renderLabels.navigation))
            }
            loaded = true
          }}
          style={{
            width: "100%",
            height: `${Math.min(contentHeight(), props.expanded ? 32000 : (props.maxHeight ?? MAX_HEIGHT))}px`,
            border: "none",
            display: "block",
            background: "transparent",
          }}
        />
      </Show>
    </div>
  )
}
