export function buildWorkspaceFileBrowserUrl(
  baseUrl: string,
  path: string,
  scope?: { scopeID?: string; directory?: string },
): string {
  const normalizedBase = baseUrl.replace(/\/$/, "")
  const token = scope?.scopeID === "home" || !scope?.directory ? "home" : base64UrlEncode(scope.directory)
  const encodedPath = path.split("/").map(encodeURIComponent).join("/")
  return `${normalizedBase}/workspace/files/raw/${token}/${encodedPath}`
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}
