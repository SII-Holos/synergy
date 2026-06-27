export function desktopErrorPage(title: string, details: string): string {
  const escapedTitle = escapeHtml(title)
  const escapedDetails = escapeHtml(details)
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapedTitle}</title>
  <style>
    :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #111214; color: #f5f6f7; }
    main { width: min(640px, calc(100vw - 48px)); }
    h1 { margin: 0 0 12px; font-size: 24px; font-weight: 650; letter-spacing: 0; }
    p { margin: 0; color: #b8bdc7; line-height: 1.55; }
    pre { margin-top: 24px; padding: 16px; overflow: auto; border: 1px solid #2c3038; border-radius: 8px; background: #17191f; color: #d7dbe3; }
  </style>
</head>
<body>
  <main>
    <h1>${escapedTitle}</h1>
    <p>Synergy Desktop could not load the local application surface.</p>
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
