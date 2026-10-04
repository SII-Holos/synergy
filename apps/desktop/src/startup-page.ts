import type { DesktopThemeSnapshot } from "./theme.js"
import type { DesktopWindowState } from "./window-chrome.js"

export interface DesktopStartupPageOptions {
  chrome: "custom" | "native"
  iconDataUrl?: string
  theme: DesktopThemeSnapshot
}

export interface DesktopStartupStatus {
  title: string
  detail: string
  phase?: "starting" | "storage" | "migration" | "recovery"
  step?: number
  progress?: { current: number; total: number }
  elapsedMs?: number
  totalElapsedMs?: number
  idleMs?: number
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
      --startup-muted-text: ${colors.mutedText};
      --startup-border: ${colors.border};
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
      overflow: auto;
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
      padding: 64px 24px 48px;
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
      width: min(440px, 100%);
    }

    .startup-brand {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 28px;
      font-size: 14px;
      font-weight: 600;
    }

    .startup-mark {
      display: grid;
      width: 32px;
      height: 32px;
      place-items: center;
    }

    .startup-mark__icon,
    .startup-mark__fallback {
      width: 32px;
      height: 32px;
      border-radius: 8px;
    }

    .startup-mark__fallback {
      display: grid;
      place-items: center;
      color: var(--startup-mark-text);
      background: var(--startup-mark-bg);
      font-size: 16px;
      font-weight: 650;
    }

    .startup-status {
      margin: 0;
      font-size: 24px;
      line-height: 1.3;
      font-weight: 600;
      letter-spacing: -0.025em;
    }

    .startup-intro {
      margin: 10px 0 28px;
      color: var(--startup-muted-text);
      font-size: 14px;
      line-height: 1.6;
    }

    .startup-stages {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin: 0 0 28px;
      padding: 0;
      list-style: none;
    }

    .startup-stage {
      display: flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
      color: var(--startup-muted-text);
      font-size: 12px;
      line-height: 20px;
    }

    .startup-stage__mark {
      display: grid;
      flex: 0 0 20px;
      height: 20px;
      place-items: center;
      border: 1px solid var(--startup-border);
      border-radius: 50%;
      font-size: 11px;
      font-variant-numeric: tabular-nums;
    }

    .startup-stage[data-state="active"] {
      color: var(--startup-text);
      font-weight: 600;
    }

    .startup-stage[data-state="active"] .startup-stage__mark {
      border-color: currentColor;
    }

    .startup-stage[data-state="complete"] .startup-stage__mark {
      color: var(--startup-text);
      background: var(--startup-control-hover-bg);
      border-color: transparent;
    }

    .startup-work {
      border-top: 1px solid var(--startup-border);
      padding-top: 22px;
    }

    .startup-work__heading,
    .startup-timing {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 16px;
    }

    .startup-detail {
      margin: 0;
      min-width: 0;
      font-size: 14px;
      line-height: 1.6;
      overflow-wrap: anywhere;
    }

    .startup-step {
      flex-shrink: 0;
      color: var(--startup-muted-text);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }

    .startup-elapsed,
    .startup-total,
    .startup-activity,
    .startup-hint {
      color: var(--startup-muted-text);
      font-size: 12px;
      line-height: 1.5;
      font-variant-numeric: tabular-nums;
    }

    .startup-progress {
      width: 100%;
      height: 5px;
      margin-top: 16px;
      overflow: hidden;
      border-radius: 4px;
      background: var(--startup-border);
    }

    .startup-progress__fill {
      width: 35%;
      height: 100%;
      border-radius: inherit;
      background: var(--startup-text);
    }

    .startup-progress[aria-valuenow] .startup-progress__fill {
      animation: none;
      transition: width 180ms ease-out;
    }

    .startup-progress-meta {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 4px 12px;
      margin: 12px 0 16px;
    }

    .startup-count {
      min-height: 20px;
      font-size: 13px;
      line-height: 20px;
      font-variant-numeric: tabular-nums;
    }

    .startup-progress-note {
      color: var(--startup-muted-text);
      font-size: 12px;
      line-height: 20px;
    }

    .startup-activity {
      margin-top: 8px;
    }

    .startup-hint {
      margin: 8px 0 0;
    }

    @keyframes startup-progress {
      from { transform: translateX(0%); }
      to { transform: translateX(185%); }
    }

    @media (prefers-reduced-motion: no-preference) {
      .startup-progress:not([aria-valuenow]) .startup-progress__fill {
        animation: startup-progress 1600ms ease-in-out infinite alternate;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .startup-progress[aria-valuenow] .startup-progress__fill { transition: none; }
    }

    .startup-progress[data-quiet="true"] .startup-progress__fill {
      animation-play-state: paused;
    }

    @media (max-width: 380px) {
      .startup-stages { gap: 8px; }
      .startup-stage { flex-direction: column; align-items: flex-start; gap: 4px; }
    }
  </style>
</head>
<body>
  <div class="startup-page">
    ${customChrome}
    <main class="startup-center">
      <div class="startup-brand"><div class="startup-mark" aria-hidden="true">${icon}</div><span>Synergy</span></div>
      <h1 class="startup-status" data-startup-status aria-live="polite" aria-atomic="true">Opening Synergy</h1>
      <p class="startup-intro">Getting your workspace ready.</p>
      <ol class="startup-stages" aria-label="Startup stages">
        <li class="startup-stage" data-stage="storage" data-state="active" aria-current="step"><span class="startup-stage__mark" aria-hidden="true">1</span><span>Prepare</span></li>
        <li class="startup-stage" data-stage="migration"><span class="startup-stage__mark" aria-hidden="true">2</span><span>Update</span></li>
        <li class="startup-stage" data-stage="recovery"><span class="startup-stage__mark" aria-hidden="true">3</span><span>Restore</span></li>
        <li class="startup-stage" data-stage="starting"><span class="startup-stage__mark" aria-hidden="true">4</span><span>Open</span></li>
      </ol>
      <section class="startup-work" aria-label="Current startup task">
        <div class="startup-work__heading" aria-live="polite" aria-atomic="true">
          <p class="startup-detail" data-startup-detail id="startup-detail">Opening your workspace.</p>
          <span class="startup-step" data-startup-step hidden></span>
        </div>
        <div class="startup-progress" role="progressbar" aria-labelledby="startup-detail" aria-valuemin="0" aria-valuemax="100" aria-describedby="startup-count" aria-valuetext="Waiting for progress updates.">
          <div class="startup-progress__fill"></div>
        </div>
        <div class="startup-progress-meta"><span class="startup-count" id="startup-count">Waiting for progress updates</span><span class="startup-progress-note" data-startup-unknown-total hidden>Total not yet known</span></div>
        <div class="startup-timing"><span class="startup-elapsed" data-startup-elapsed></span><span class="startup-total" data-startup-total></span></div>
        <div class="startup-activity" data-startup-activity></div>
        <p class="startup-hint" data-startup-hint hidden>Some steps take a while between updates.</p>
      </section>
    </main>
  </div>
  <script>
    const desktopWindow = window.synergyDesktop?.window
    const status = document.querySelector("[data-startup-status]")
    const detail = document.querySelector("[data-startup-detail]")
    const progress = document.querySelector('[role="progressbar"]')
    const fill = document.querySelector(".startup-progress__fill")
    const count = document.querySelector(".startup-count")
    const maximize = document.querySelector('[data-window-action="maximize"]')
    let windowStateRevision = 0

    const elapsed = document.querySelector("[data-startup-elapsed]")
    const total = document.querySelector("[data-startup-total]")
    const activity = document.querySelector("[data-startup-activity]")
    const hint = document.querySelector("[data-startup-hint]")
    const step = document.querySelector("[data-startup-step]")
    const unknownTotal = document.querySelector("[data-startup-unknown-total]")
    const stages = Array.from(document.querySelectorAll("[data-stage]"))
    let waitingSince = performance.now()
    let totalSince = waitingSince
    let progressSince = waitingSince
    let received = false
    function duration(ms) {
      const seconds = Math.max(0, Math.floor(ms / 1000))
      return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0")
    }
    function renderElapsed() {
      const now = performance.now()
      elapsed.textContent = "Waiting " + duration(now - waitingSince)
      total.textContent = "Total " + duration(now - totalSince)
      const idle = now - progressSince
      activity.textContent = !received ? "Waiting for the first update" : idle < 5000 ? "Progress received just now" : "Last progress " + duration(idle) + " ago"
      hint.hidden = !received || idle < 30000
      progress.dataset.quiet = String(idle >= 30000)
    }
    renderElapsed()
    setInterval(renderElapsed, 1000)

    function setStatus(next) {
      if (!next) return
      if (typeof next.title === "string" && status.textContent !== next.title) status.textContent = next.title
      if (typeof next.detail === "string" && detail.textContent !== next.detail) detail.textContent = next.detail
      const now = performance.now()
      const value = next.progress
      const checked = Number.isSafeInteger(value?.current) && value.current >= 0 && Number.isSafeInteger(value?.total) && value.total >= 0 && (value.total === 0 || value.current <= value.total)
      if (Number.isFinite(next.elapsedMs)) waitingSince = now - Math.max(0, next.elapsedMs)
      if (Number.isFinite(next.totalElapsedMs)) totalSince = Math.min(totalSince, now - Math.max(0, next.totalElapsedMs))
      if (Number.isFinite(next.idleMs) || checked || next.phase === "starting") {
        progressSince = now - (Number.isFinite(next.idleMs) ? Math.max(0, next.idleMs) : 0)
        received = true
      }
      step.hidden = !Number.isSafeInteger(next.step) || next.step <= 0
      const stepText = step.hidden ? "" : "Step " + next.step
      if (step.textContent !== stepText) step.textContent = stepText
      const active = stages.findIndex(stage => stage.dataset.stage === next.phase)
      if (active >= 0) stages.forEach((stage, index) => {
        stage.dataset.state = index < active ? "complete" : index === active ? "active" : "pending"
        stage.querySelector(".startup-stage__mark").textContent = index < active ? "✓" : String(index + 1)
        if (index === active) stage.setAttribute("aria-current", "step")
        else stage.removeAttribute("aria-current")
      })
      renderElapsed()
      if (checked && value.total > 0) {
        unknownTotal.hidden = true
        const percent = Math.floor(value.current / value.total * 100)
        const text = value.current.toLocaleString("en") + " / " + value.total.toLocaleString("en") + " · " + percent + "%"
        progress.setAttribute("aria-valuenow", String(percent))
        progress.setAttribute("aria-valuetext", text)
        fill.style.width = (value.current / value.total * 100) + "%"
        count.textContent = text
      } else {
        progress.removeAttribute("aria-valuenow")
        fill.style.removeProperty("width")
        const unknown = checked && value.total === 0
        unknownTotal.hidden = !unknown
        count.textContent = unknown ? value.current.toLocaleString("en") + (value.current === 1 ? " item checked" : " items checked") : "Waiting for progress updates"
        progress.setAttribute("aria-valuetext", count.textContent + (unknown ? ". Total not yet known." : "."))
      }
    }

    function setStartupTheme(theme) {
      if (!theme || (theme.effective !== "light" && theme.effective !== "dark")) return
      const colors = theme.colors
      const fields = {
        background: "--startup-bg",
        text: "--startup-text",
        mutedText: "--startup-muted-text",
        border: "--startup-border",
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
      const revision = ++windowStateRevision
      desktopWindow?.toggleMaximize?.().then(state => {
        if (revision === windowStateRevision) updateMaximizeLabel(state)
      }).catch(() => {})
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

    function setWindowState(state) {
      windowStateRevision++
      updateMaximizeLabel(state)
    }
    window.synergySetStartupWindowState = setWindowState

    const initialWindowStateRevision = windowStateRevision
    desktopWindow?.state?.().then(state => {
      if (initialWindowStateRevision === windowStateRevision) updateMaximizeLabel(state)
    }).catch(() => {})
    desktopWindow?.onEvent?.((event) => {
      if (event?.type === "state") setWindowState(event.state)
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

export function startupWindowStateScript(state: DesktopWindowState): string {
  return `window.synergySetStartupWindowState?.(${JSON.stringify(state)})`
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")
}
