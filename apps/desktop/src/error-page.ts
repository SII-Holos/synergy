import { desktopThemeBackground, type DesktopThemeSnapshot } from "./theme.js"

export function desktopErrorPage(title: string, details: string, theme: DesktopThemeSnapshot): string {
  const escapedTitle = escapeHtml(title)
  const escapedDetails = escapeHtml(details)
  const reason = escapeHtml(details.split("\n")[0] || "The local application could not start.")
  const background = desktopThemeBackground(theme)
  const { colors } = theme
  const html = `<!doctype html>
<html lang="en" data-error-theme="${theme.effective}">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapedTitle}</title>
  <style>
    :root { color-scheme: ${theme.effective}; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; --error-bg: ${background}; --error-text: ${colors.text}; --error-muted: ${colors.mutedText}; --error-panel-bg: ${colors.panel}; --error-panel-border: ${colors.border}; --error-code: ${colors.text}; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--error-bg); color: var(--error-text); }
    main { width: min(800px, calc(100vw - 48px)); max-height: calc(100vh - 80px); display: flex; flex-direction: column; }
    h1 { margin: 0 0 12px; font-size: 24px; font-weight: 650; letter-spacing: 0; }
    p { overflow-wrap: anywhere; margin: 0; color: var(--error-muted); line-height: 1.55; }
    .error-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 20px; }
    button { padding: 8px 14px; border: 1px solid var(--error-panel-border); border-radius: 7px; background: var(--error-panel-bg); color: var(--error-text); cursor: pointer; }
    button:hover:not(:disabled), button:focus-visible { border-color: var(--error-text); }
    button:disabled { cursor: wait; opacity: .55; }
    .error-status { min-height: 1.5em; margin-top: 10px; font-size: 13px; }
    pre { min-height: 0; flex-shrink: 1; max-height: 50vh; white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 16px; padding: 16px; overflow: auto; border: 1px solid var(--error-panel-border); border-radius: 8px; background: var(--error-panel-bg); color: var(--error-code); }
  </style>
</head>
<body>
  <main>
    <h1>${escapedTitle}</h1>
    <p>${reason}</p>
    <div class="error-actions" role="group" aria-label="Recovery actions">
      <button type="button" data-error-action="retry">Retry</button>
      <button type="button" data-error-action="maintenance">Continue maintenance</button>
      <button type="button" data-error-action="return" hidden>Return to Synergy</button>
      <button type="button" data-error-action="diagnostics">Export diagnostics</button>
    </div>
    <p class="error-status" data-error-status role="status" aria-live="polite"></p>
    <pre>${escapedDetails}</pre>
  </main>
  <script>
    (() => {
      const bridge = window.synergyDesktop && window.synergyDesktop.server
      const status = document.querySelector('[data-error-status]')
      const buttons = [...document.querySelectorAll('[data-error-action]')]
      const setStatus = (message) => { if (status) status.textContent = message }
      let action = null
      let mode = null
      let running = false
      let polling = false
      let disposed = false
      const updateButtons = () => buttons.forEach((button) => {
        const name = button.dataset.errorAction
        button.hidden = name === 'return' && !running
        button.disabled = name === 'return'
          ? action === 'return' || !bridge?.cancelMaintenance
          : Boolean(action) || running || (mode === 'external' && name !== 'retry')
      })
      const refresh = async () => {
        if (!bridge?.status || polling || disposed) return
        polling = true
        try {
          const value = await bridge.status()
          if (disposed) return
          mode = value?.mode
          running = value?.maintenance?.state === 'running'
          if (running && action !== 'return') {
            const progress = value.maintenance.progress
            setStatus(progress
              ? 'Updating saved data… step ' + progress.step + ': ' + progress.current + (progress.total ? ' / ' + progress.total : ' processed')
              : value.maintenance.detail || 'Preparing maintenance… You can return to Synergy and continue later.')
          } else if (mode === 'external' && !action) {
            setStatus('This Desktop uses an external server. On that host, stop Synergy, then run: synergy migration run storage --maintenance. Restart the server afterward.')
          }
          updateButtons()
        } catch {} finally { polling = false }
      }
      const run = async (next) => {
        if (!bridge) { setStatus('Desktop recovery controls are unavailable. Restart the application.'); return }
        if (action && next !== 'return') return
        if (next === 'return' && action === 'return') return
        action = next
        if (next === 'maintenance') running = true
        updateButtons()
        setStatus(next === 'maintenance' ? 'Preparing maintenance… You can return to Synergy and continue later.' : next === 'diagnostics' ? 'Exporting diagnostics…' : next === 'return' ? 'Saving progress and returning to Synergy…' : 'Retrying…')
        try {
          if (next === 'diagnostics') {
            if (!bridge.diagnostics) throw new Error('Diagnostics export is unavailable in this Desktop version.')
            const output = await bridge.diagnostics()
            setStatus('Diagnostics package created: ' + output)
          } else if (next === 'return') {
            await bridge.cancelMaintenance()
          } else if (next === 'maintenance') {
            if (!bridge.maintenance) throw new Error('Storage maintenance is unavailable in this Desktop version.')
            await bridge.maintenance()
          } else await bridge.restart()
        } catch (error) {
          if (action === next) setStatus(error && error.message ? error.message : String(error))
        } finally {
          if (action === next) action = null
          await refresh()
          updateButtons()
        }
      }
      buttons.forEach((button) => button.addEventListener('click', () => run(button.dataset.errorAction)))
      const timer = setInterval(refresh, 1000)
      window.addEventListener('pagehide', () => { disposed = true; clearInterval(timer) }, { once: true })
      void refresh()
    })()
  </script>
</body>
</html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")
}
