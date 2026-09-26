export type WorkspaceFileUrlScope = { scopeID: string; workspaceID: string; workspaceGeneration: number }

export function buildWorkspaceFileBrowserUrl(baseUrl: string, path: string, scope?: WorkspaceFileUrlScope): string {
  const normalizedBase = baseUrl.replace(/\/$/, "")
  if (
    !scope?.scopeID ||
    !scope.workspaceID ||
    !Number.isSafeInteger(scope.workspaceGeneration) ||
    scope.workspaceGeneration < 1
  )
    throw new Error("A Scope and Workspace binding are required to open a workspace file")
  const token = scope.scopeID === "home" ? "home" : base64UrlEncode(scope.scopeID)
  const encodedPath = path.split("/").map(encodeURIComponent).join("/")
  return `${normalizedBase}/workspace/files/raw/${token}/${encodeURIComponent(scope.workspaceID)}/${scope.workspaceGeneration}/${encodedPath}`
}

// The raw route sets X-Frame-Options: SAMEORIGIN, so the preview iframe must
// be same-origin with the app page. When the SDK base points at another origin
// (bun dev serves the app from Vite and the server from :4096, which Vite
// proxies), fall back to the app origin. When same-origin, keep the SDK base so
// a reverse-proxy prefix is preserved. The version query forces a reload when
// the file changes on disk.
export function buildWorkspaceFilePreviewUrl(
  baseUrl: string,
  appOrigin: string,
  path: string,
  scope?: WorkspaceFileUrlScope,
  version?: { mtime: number; size: number; contentVersion?: string },
): string {
  let base = appOrigin
  try {
    if (baseUrl && new URL(baseUrl).origin === new URL(appOrigin).origin) base = baseUrl
  } catch {
    // keep the app-origin fallback
  }
  const rawUrl = buildWorkspaceFileBrowserUrl(base, path, scope)
  return version
    ? `${rawUrl}?v=${encodeURIComponent(version.contentVersion ?? `${version.mtime}-${version.size}`)}`
    : rawUrl
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}
