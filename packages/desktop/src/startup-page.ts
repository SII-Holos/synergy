import type { DesktopThemeSnapshot } from "./theme.js"

export interface DesktopStartupPageOptions {
  chrome: "custom" | "native"
  iconDataUrl?: string
  theme: DesktopThemeSnapshot
}

export interface DesktopStartupStatus {
  title: string
  detail: string
}

export function desktopStartupPage(options: DesktopStartupPageOptions): string {
  const { effective, colors } = options.theme
  const icon = options.iconDataUrl
    ? `<img class="startup-mark__icon" src="${escapeAttribute(options.iconDataUrl)}" alt="" draggable="false">`
    : `<span class="startup-mark__fallback" aria-hidden="true">S</span>`
  const customChrome =
    options.chrome === "custom"
      ? `<header class="startup-chrome">
  <div class="startup-chrome__drag"></div>
  <div class="startup-chrome__controls">
    <button type="button" class="startup-chrome__control" data-window-action="minimize" aria-label="Minimize" title="Minimize">
      <span class="startup-chrome__glyph startup-chrome__glyph--minimize"></span>
    </button>
    <button type="button" class="startup-chrome__control" data-window-action="maximize" aria-label="Maximize" title="Maximize">
      <span class="startup-chrome__glyph startup-chrome__glyph--maximize"></span>
    </button>
    <button type="button" class="startup-chrome__control startup-chrome__control--close" data-window-action="close" aria-label="Close" title="Close">
      <span class="startup-chrome__glyph startup-chrome__glyph--close"></span>
    </button>
  </div>
</header>`
      : `<header class="startup-native-titlebar">
  <div class="startup-native-titlebar__traffic-space"></div>
  <div class="startup-native-titlebar__drag"></div>
</header>`

  const html = `<!doctype html>
<html lang="en" data-startup-theme="${effective}">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Starting Synergy</title>
  <style>
    :root {
      color-scheme: ${effective};
      --startup-bg: ${colors.background};
      --startup-text: ${colors.text};
      --startup-mark-bg: ${colors.markBackground};
      --startup-mark-text: ${colors.markText};
      --startup-control-color: ${colors.control};
      --startup-control-hover-color: ${colors.controlHover};
      --startup-control-hover-bg: ${colors.controlHoverBackground};
      --startup-focus-ring: ${colors.focus};
      --startup-critical-bg: ${colors.criticalBackground};
      --startup-critical-text: ${colors.criticalText};
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      overflow: hidden;
      background: var(--startup-bg);
      color: var(--startup-text);
    }

    button {
      font: inherit;
    }

    .startup-page {
      position: relative;
      display: grid;
      min-height: 100vh;
      place-items: center;
      background: var(--startup-bg);
    }

    .startup-chrome {
      position: fixed;
      top: 0;
      right: 0;
      left: 0;
      z-index: 2;
      display: flex;
      align-items: stretch;
      height: 36px;
      user-select: none;
      -webkit-app-region: drag;
    }

    .startup-chrome__drag {
      flex: 1;
      min-width: 0;
    }

    .startup-chrome__controls {
      display: flex;
      align-items: stretch;
      height: 100%;
      margin-left: auto;
      -webkit-app-region: no-drag;
    }

    .startup-chrome__control {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 46px;
      height: 100%;
      padding: 0;
      color: var(--startup-control-color);
      background: transparent;
      border: 0;
      border-radius: 0;
      transition:
        background-color 140ms cubic-bezier(0.16, 1, 0.3, 1),
        color 140ms cubic-bezier(0.16, 1, 0.3, 1);
    }

    .startup-chrome__control:hover,
    .startup-chrome__control:focus-visible {
      color: var(--startup-control-hover-color);
      background: var(--startup-control-hover-bg);
      outline: none;
    }

    .startup-chrome__control:focus-visible {
      box-shadow: inset 0 0 0 2px var(--startup-focus-ring);
    }

    .startup-chrome__control--close:hover,
    .startup-chrome__control--close:focus-visible {
      color: var(--startup-critical-text);
      background: var(--startup-critical-bg);
    }

    .startup-chrome__glyph {
      position: relative;
      display: block;
      width: 12px;
      height: 12px;
    }

    .startup-chrome__glyph--minimize::before {
      position: absolute;
      right: 1px;
      bottom: 2px;
      left: 1px;
      height: 1px;
      background: currentColor;
      content: "";
    }

    .startup-chrome__glyph--maximize::before {
      position: absolute;
      inset: 1px;
      border: 1px solid currentColor;
      content: "";
    }

    .startup-chrome__glyph--close::before,
    .startup-chrome__glyph--close::after {
      position: absolute;
      top: 5px;
      left: 1px;
      width: 10px;
      height: 1px;
      background: currentColor;
      content: "";
    }

    .startup-chrome__glyph--close::before {
      transform: rotate(45deg);
    }

    .startup-chrome__glyph--close::after {
      transform: rotate(-45deg);
    }

    .startup-native-titlebar {
      position: fixed;
      top: 0;
      right: 0;
      left: 0;
      z-index: 2;
      display: flex;
      height: 28px;
      user-select: none;
      -webkit-app-region: drag;
    }

    .startup-native-titlebar__traffic-space {
      flex: 0 0 90px;
      height: 100%;
    }

    .startup-native-titlebar__drag {
      flex: 1;
      min-width: 0;
    }

    .startup-center {
      display: grid;
      place-items: center;
    }

    .startup-mark {
      position: relative;
      display: grid;
      width: 96px;
      height: 96px;
      place-items: center;
      animation: startup-breathe 1600ms cubic-bezier(0.4, 0, 0.2, 1) infinite;
    }

    .startup-mark__icon,
    .startup-mark__fallback {
      position: relative;
      width: 72px;
      height: 72px;
      border-radius: 14px;
    }

    .startup-mark__fallback {
      display: grid;
      place-items: center;
      color: var(--startup-mark-text);
      background: var(--startup-mark-bg);
      font-size: 32px;
      font-weight: 650;
    }

    .startup-status {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
    }

    @keyframes startup-breathe {
      0%,
      100% {
        opacity: 0.72;
        transform: scale(0.96);
      }
      50% {
        opacity: 1;
        transform: scale(1);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .startup-mark {
        animation: none;
      }
    }
  </style>
</head>
<body>
  <div class="startup-page">
    ${customChrome}
    <main class="startup-center" aria-live="polite" aria-busy="true">
      <div class="startup-mark" aria-hidden="true">${icon}</div>
      <div class="startup-status" data-startup-status>Opening Synergy</div>
    </main>
  </div>
  <script>
    const desktopWindow = window.synergyDesktop?.window
    const status = document.querySelector("[data-startup-status]")
    const maximize = document.querySelector('[data-window-action="maximize"]')

    function setStatus(next) {
      if (!next) return
      if (typeof next.title === "string") status.textContent = next.title
      if (typeof next.detail === "string") status.setAttribute("data-detail", next.detail)
    }

    function setStartupTheme(theme) {
      if (!theme || (theme.effective !== "light" && theme.effective !== "dark")) return
      const colors = theme.colors
      const fields = {
        background: "--startup-bg",
        text: "--startup-text",
        markBackground: "--startup-mark-bg",
        markText: "--startup-mark-text",
        control: "--startup-control-color",
        controlHover: "--startup-control-hover-color",
        controlHoverBackground: "--startup-control-hover-bg",
        focus: "--startup-focus-ring",
        criticalBackground: "--startup-critical-bg",
        criticalText: "--startup-critical-text",
      }
      const hex = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
      for (const field in fields) if (!hex.test(colors?.[field])) return
      document.documentElement.setAttribute("data-startup-theme", theme.effective)
      document.documentElement.style.setProperty("color-scheme", theme.effective)
      for (const field in fields) document.documentElement.style.setProperty(fields[field], colors[field])
    }

    window.synergySetStartupStatus = setStatus
    window.synergySetStartupTheme = setStartupTheme

    document.querySelector('[data-window-action="minimize"]')?.addEventListener("click", () => {
      desktopWindow?.minimize?.()
    })
    maximize?.addEventListener("click", () => {
      desktopWindow?.toggleMaximize?.()
    })
    document.querySelector('[data-window-action="close"]')?.addEventListener("click", () => {
      desktopWindow?.close?.()
    })

    function updateMaximizeLabel(state) {
      if (!maximize) return
      const label = state?.maximized || state?.fullscreen ? "Restore" : "Maximize"
      maximize.setAttribute("aria-label", label)
      maximize.setAttribute("title", label)
    }

    desktopWindow?.state?.().then(updateMaximizeLabel).catch(() => {})
    desktopWindow?.onEvent?.((event) => {
      if (event?.type === "state") updateMaximizeLabel(event.state)
    })
  </script>
</body>
</html>`

  return `data:text/html,${encodeURIComponent(html)}`
}

export function startupStatusScript(status: DesktopStartupStatus): string {
  return `window.synergySetStartupStatus?.(${JSON.stringify(status)})`
}

export function startupThemeScript(theme: DesktopThemeSnapshot): string {
  return `window.synergySetStartupTheme?.(${JSON.stringify(theme)})`
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")
}
