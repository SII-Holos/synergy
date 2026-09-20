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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapedTitle}</title>
  <style>
    :root { color-scheme: ${theme.effective}; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; --error-bg: ${background}; --error-text: ${colors.text}; --error-muted: ${colors.mutedText}; --error-panel-bg: ${colors.panel}; --error-panel-border: ${colors.border}; --error-code: ${colors.text}; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--error-bg); color: var(--error-text); }
    main { width: min(800px, calc(100vw - 48px)); max-height: calc(100vh - 80px); display: flex; flex-direction: column; }
    h1 { margin: 0 0 12px; font-size: 24px; font-weight: 650; letter-spacing: 0; }
    p { overflow-wrap: anywhere; margin: 0; color: var(--error-muted); line-height: 1.55; }
    pre { min-height: 0; flex-shrink: 1; max-height: 60vh; white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 24px; padding: 16px; overflow: auto; border: 1px solid var(--error-panel-border); border-radius: 8px; background: var(--error-panel-bg); color: var(--error-code); }
  </style>
</head>
<body>
  <main>
    <h1>${escapedTitle}</h1>
    <p>${reason}</p>
    <pre>${escapedDetails}</pre>
  </main>
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
