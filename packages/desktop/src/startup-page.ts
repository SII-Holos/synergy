export interface DesktopStartupPageOptions {
  chrome: "custom" | "native"
  iconUrl?: string
}

export interface DesktopStartupStatus {
  title: string
  detail: string
}

export function desktopStartupPage(options: DesktopStartupPageOptions): string {
  const icon = (className: string) =>
    options.iconUrl
      ? `<img class="${className}" src="${escapeAttribute(options.iconUrl)}" alt="" draggable="false">`
      : `<span class="${className} startup-shell__icon--fallback"></span>`
  const windowIcon = options.iconUrl
    ? `<img class="startup-shell__icon" src="${escapeAttribute(options.iconUrl)}" alt="" draggable="false">`
    : ""
  const customChrome =
    options.chrome === "custom"
      ? `<header class="startup-chrome">
  <div class="startup-chrome__brand">
    ${windowIcon}
    <span>Synergy</span>
  </div>
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
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: file:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Starting Synergy</title>
  <style>
    :root {
      color-scheme: dark;
      --startup-background: #111214;
      --startup-sidebar: #101112;
      --startup-workbench: #111214;
      --startup-content: #24262a;
      --startup-border: #25272b;
      --startup-text: #f5f6f7;
      --startup-muted: #b8bdc7;
      --startup-faint: #8a8f99;
      --startup-fill: #303238;
      --startup-line: #24262a;
      --startup-line-strong: #4b4f59;
      --startup-progress: #d7dbe3;
      --startup-shadow: rgba(0, 0, 0, 0.28);
      --startup-danger: oklch(0.58 0.22 28);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      overflow: hidden;
      background: var(--startup-background);
      color: var(--startup-text);
    }

    button {
      font: inherit;
    }

    .startup-page {
      display: flex;
      flex-direction: column;
      min-height: 100vh;
      background: var(--startup-background);
    }

    .startup-chrome {
      display: flex;
      align-items: center;
      flex: 0 0 36px;
      height: 36px;
      min-height: 36px;
      color: var(--startup-text);
      background: var(--startup-background);
      border-bottom: 1px solid var(--startup-border);
      user-select: none;
      -webkit-app-region: drag;
    }

    .startup-chrome__brand {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 168px;
      height: 100%;
      padding: 0 12px;
      font-size: 12px;
      font-weight: 500;
      -webkit-app-region: no-drag;
    }

    .startup-shell__icon {
      width: 20px;
      height: 20px;
      flex: 0 0 auto;
      border-radius: 5px;
    }

    .startup-chrome__drag {
      flex: 1;
      align-self: stretch;
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
      color: var(--startup-faint);
      background: transparent;
      border: 0;
      border-radius: 0;
      transition:
        background-color 140ms cubic-bezier(0.16, 1, 0.3, 1),
        color 140ms cubic-bezier(0.16, 1, 0.3, 1);
    }

    .startup-chrome__control:hover,
    .startup-chrome__control:focus-visible {
      color: var(--startup-text);
      background: var(--startup-fill);
      outline: none;
    }

    .startup-chrome__control:focus-visible {
      box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--startup-text) 18%, transparent);
    }

    .startup-chrome__control--close:hover,
    .startup-chrome__control--close:focus-visible {
      color: white;
      background: var(--startup-danger);
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
      position: relative;
      z-index: 1;
      display: flex;
      flex: 0 0 18px;
      height: 18px;
      min-height: 18px;
      user-select: none;
      -webkit-app-region: drag;
    }

    .startup-native-titlebar__traffic-space {
      flex: 0 0 90px;
      height: 100%;
    }

    .startup-native-titlebar__drag {
      flex: 1;
      align-self: stretch;
      min-width: 0;
    }

    .startup-shell {
      display: flex;
      flex: 1;
      min-height: 0;
      overflow: hidden;
      background: var(--startup-workbench);
    }

    .startup-sidebar {
      display: flex;
      flex: 0 0 240px;
      flex-direction: column;
      min-width: 0;
      padding: 18px 16px 16px;
      background: var(--startup-sidebar);
      border-right: 1px solid var(--startup-border);
    }

    .startup-org {
      display: flex;
      align-items: center;
      gap: 9px;
      margin-bottom: 28px;
      color: var(--startup-text);
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 0;
    }

    .startup-org__mark {
      width: 28px;
      height: 28px;
      border-radius: 999px;
      background: var(--startup-text);
    }

    .startup-rail {
      display: grid;
      gap: 10px;
    }

    .startup-row {
      display: flex;
      align-items: center;
      gap: 10px;
      height: 28px;
    }

    .startup-row__icon {
      width: 14px;
      height: 14px;
      border: 1px solid var(--startup-faint);
      border-radius: 4px;
    }

    .startup-line {
      display: block;
      height: 8px;
      background: var(--startup-line);
      border-radius: 999px;
    }

    .startup-line--xl {
      width: 132px;
    }

    .startup-line--lg {
      width: 104px;
    }

    .startup-line--md {
      width: 76px;
    }

    .startup-line--sm {
      width: 48px;
    }

    .startup-sidebar__spacer {
      flex: 1;
      min-height: 24px;
    }

    .startup-account {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .startup-shell__icon--account {
      width: 22px;
      height: 22px;
    }

    .startup-shell__icon--fallback {
      display: inline-block;
      background: var(--startup-line-strong);
    }

    .startup-workbench {
      display: flex;
      flex: 1;
      flex-direction: column;
      min-width: 0;
      background: var(--startup-workbench);
    }

    .startup-topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex: 0 0 52px;
      min-height: 52px;
      padding: 0 28px;
      border-bottom: 1px solid color-mix(in srgb, var(--startup-border) 70%, transparent);
    }

    .startup-topbar__title {
      width: 142px;
      height: 10px;
      background: var(--startup-line);
      border-radius: 999px;
    }

    .startup-topbar__tools {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .startup-tool {
      width: 18px;
      height: 18px;
      border: 1px solid var(--startup-line-strong);
      border-radius: 5px;
    }

    .startup-canvas {
      display: flex;
      flex: 1;
      align-items: center;
      justify-content: center;
      min-height: 0;
      padding: 64px 8vw;
    }

    .startup-stage {
      transform: translateY(clamp(24px, 5vh, 64px));
      width: min(54rem, 100%);
    }

    .startup-logo-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 14px;
    }

    .startup-shell__icon--stage {
      width: 26px;
      height: 26px;
    }

    .startup-kicker {
      color: var(--startup-muted);
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0;
    }

    h1 {
      max-width: 560px;
      margin: 0;
      color: var(--startup-text);
      font-size: 32px;
      font-weight: 650;
      letter-spacing: 0;
      line-height: 1.12;
    }

    p {
      max-width: 520px;
      margin: 12px 0 0;
      color: var(--startup-muted);
      font-size: 14px;
      line-height: 1.5;
    }

    .startup-composer {
      margin-top: 28px;
      padding: 16px 18px 14px;
      background: var(--startup-content);
      border: 1px solid color-mix(in srgb, var(--startup-line-strong) 70%, transparent);
      border-radius: 8px;
      box-shadow: 0 20px 56px var(--startup-shadow);
    }

    .startup-prompt-line {
      width: min(360px, 80%);
      height: 12px;
      background: var(--startup-line-strong);
      border-radius: 999px;
    }

    .startup-composer__footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-top: 22px;
    }

    .startup-chip-row {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }

    .startup-chip {
      width: 62px;
      height: 18px;
      background: var(--startup-fill);
      border-radius: 999px;
    }

    .startup-chip--short {
      width: 42px;
    }

    .startup-submit {
      width: 30px;
      height: 30px;
      background: var(--startup-faint);
      border-radius: 999px;
    }

    .startup-progress {
      position: relative;
      height: 2px;
      margin-top: 18px;
      overflow: hidden;
      background: var(--startup-fill);
    }

    .startup-progress::before {
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
      width: 38%;
      background: var(--startup-progress);
      content: "";
      animation: startup-progress 1200ms cubic-bezier(0.65, 0, 0.35, 1) infinite;
    }

    .startup-step {
      margin-top: 12px;
      color: var(--startup-faint);
      font-size: 12px;
      line-height: 1.45;
    }

    @keyframes startup-progress {
      0% {
        transform: translateX(-100%);
      }
      100% {
        transform: translateX(280%);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .startup-progress::before {
        width: 42%;
        animation: none;
      }
    }

    @media (max-width: 720px) {
      .startup-chrome__brand {
        min-width: 72px;
      }

      .startup-chrome__brand span {
        display: none;
      }

      .startup-sidebar,
      .startup-topbar__tools {
        display: none;
      }

      .startup-topbar {
        padding: 0 20px;
      }

      .startup-canvas {
        align-items: center;
        padding: 40px 24px 56px;
      }

      .startup-stage {
        transform: none;
      }

      h1 {
        font-size: 28px;
      }

      .startup-composer {
        padding: 15px 16px 13px;
      }
    }
  </style>
</head>
<body>
  <div class="startup-page">
    ${customChrome}
    <main class="startup-shell">
      <aside class="startup-sidebar" aria-hidden="true">
        <div class="startup-org">
          <span class="startup-org__mark"></span>
          <span>HOLOS</span>
        </div>
        <div class="startup-rail">
          <div class="startup-row">
            <span class="startup-row__icon"></span>
            <span class="startup-line startup-line--md"></span>
          </div>
          <div class="startup-row">
            <span class="startup-row__icon"></span>
            <span class="startup-line startup-line--lg"></span>
          </div>
          <div class="startup-row">
            <span class="startup-row__icon"></span>
            <span class="startup-line startup-line--md"></span>
          </div>
          <div class="startup-row">
            <span class="startup-row__icon"></span>
            <span class="startup-line startup-line--sm"></span>
          </div>
        </div>
        <div class="startup-sidebar__spacer"></div>
        <div class="startup-account">
          ${icon("startup-shell__icon startup-shell__icon--account")}
          <span class="startup-line startup-line--lg"></span>
        </div>
      </aside>
      <section class="startup-workbench">
        <div class="startup-topbar" aria-hidden="true">
          <span class="startup-topbar__title"></span>
          <div class="startup-topbar__tools">
            <span class="startup-tool"></span>
            <span class="startup-tool"></span>
          </div>
        </div>
        <div class="startup-canvas">
          <section class="startup-stage" aria-live="polite" aria-busy="true">
            <div class="startup-logo-row">
              ${icon("startup-shell__icon startup-shell__icon--stage")}
              <span class="startup-kicker">Synergy</span>
            </div>
            <h1 data-startup-title>Opening Synergy</h1>
            <p data-startup-detail>Preparing the desktop shell.</p>
            <div class="startup-composer">
              <div class="startup-prompt-line"></div>
              <div class="startup-composer__footer">
                <div class="startup-chip-row">
                  <span class="startup-chip"></span>
                  <span class="startup-chip startup-chip--short"></span>
                </div>
                <span class="startup-submit"></span>
              </div>
              <div class="startup-progress" role="progressbar" aria-label="Starting Synergy"></div>
            </div>
            <div class="startup-step" data-startup-step>Starting</div>
          </section>
        </div>
      </section>
    </main>
  </div>
  <script>
    const desktopWindow = window.synergyDesktop?.window
    const title = document.querySelector("[data-startup-title]")
    const detail = document.querySelector("[data-startup-detail]")
    const step = document.querySelector("[data-startup-step]")
    const maximize = document.querySelector('[data-window-action="maximize"]')

    function setStatus(next) {
      if (!next) return
      if (typeof next.title === "string") title.textContent = next.title
      if (typeof next.detail === "string") detail.textContent = next.detail
      if (typeof next.title === "string") step.textContent = next.title
    }

    window.synergySetStartupStatus = setStatus

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

    window.setTimeout(() => {
      if (detail.textContent !== "Preparing the desktop shell.") return
      setStatus({
        title: "Starting local runtime",
        detail: "Synergy is opening the local server and workspace."
      })
    }, 3000)
  </script>
</body>
</html>`

  return `data:text/html,${encodeURIComponent(html)}`
}

export function startupStatusScript(status: DesktopStartupStatus): string {
  return `window.synergySetStartupStatus?.(${JSON.stringify(status)})`
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")
}
