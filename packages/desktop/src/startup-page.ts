export interface DesktopStartupPageOptions {
  chrome: "custom" | "native"
  iconUrl?: string
}

export interface DesktopStartupStatus {
  title: string
  detail: string
}

export function desktopStartupPage(options: DesktopStartupPageOptions): string {
  const icon = options.iconUrl
    ? `<img class="startup-shell__icon" src="${escapeAttribute(options.iconUrl)}" alt="" draggable="false">`
    : ""
  const customChrome =
    options.chrome === "custom"
      ? `<header class="startup-chrome">
  <div class="startup-chrome__brand">
    ${icon}
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
      --startup-shell: #14161a;
      --startup-content: #17191f;
      --startup-border: #2c3038;
      --startup-text: #f5f6f7;
      --startup-muted: #b8bdc7;
      --startup-faint: #818895;
      --startup-fill: #242832;
      --startup-progress: #d7dbe3;
      --startup-danger: oklch(0.58 0.22 28);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    @media (prefers-color-scheme: light) {
      :root {
        color-scheme: light;
        --startup-background: #f7f7f5;
        --startup-shell: #ffffff;
        --startup-content: #ffffff;
        --startup-border: #deded8;
        --startup-text: #1c1d20;
        --startup-muted: #5f636b;
        --startup-faint: #858992;
        --startup-fill: #ededeb;
        --startup-progress: #303238;
      }
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

    .startup-main {
      display: grid;
      flex: 1;
      place-items: center;
      padding: 48px 32px 64px;
    }

    .startup-panel {
      width: min(420px, calc(100vw - 48px));
    }

    .startup-wordmark {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 28px;
      color: var(--startup-muted);
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0;
    }

    .startup-wordmark__rule {
      flex: 1;
      height: 1px;
      background: var(--startup-border);
    }

    h1 {
      margin: 0 0 10px;
      color: var(--startup-text);
      font-size: 24px;
      font-weight: 650;
      letter-spacing: 0;
      line-height: 1.2;
    }

    p {
      margin: 0;
      color: var(--startup-muted);
      font-size: 13px;
      line-height: 1.55;
    }

    .startup-progress {
      position: relative;
      height: 2px;
      margin-top: 28px;
      overflow: hidden;
      background: var(--startup-fill);
    }

    .startup-progress::before {
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
      width: 36%;
      background: var(--startup-progress);
      content: "";
      animation: startup-progress 1200ms cubic-bezier(0.65, 0, 0.35, 1) infinite;
    }

    .startup-step {
      margin-top: 14px;
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

      .startup-main {
        align-items: center;
        padding: 40px 24px 56px;
      }
    }
  </style>
</head>
<body>
  <div class="startup-page">
    ${customChrome}
    <main class="startup-main">
      <section class="startup-panel" aria-live="polite" aria-busy="true">
        <div class="startup-wordmark">
          <span>Synergy</span>
          <span class="startup-wordmark__rule"></span>
        </div>
        <h1 data-startup-title>Starting local workspace</h1>
        <p data-startup-detail>Preparing the desktop shell.</p>
        <div class="startup-progress" role="progressbar" aria-label="Starting Synergy"></div>
        <div class="startup-step" data-startup-step>Starting</div>
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
