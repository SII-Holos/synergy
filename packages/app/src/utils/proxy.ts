declare global {
  interface Window {
    __SYNERGY_ROUTE__?: string
  }
}

let cachedPrefix: string | undefined

export function resolveProxyPrefix(fullPath: string, route: string | undefined) {
  if (route != null && fullPath !== route && fullPath.endsWith(route)) {
    return fullPath.slice(0, fullPath.length - route.length).replace(/\/+$/, "")
  }
  return ""
}

export function proxyPrefix() {
  if (cachedPrefix !== undefined) return cachedPrefix
  cachedPrefix = resolveProxyPrefix(window.location.pathname, window.__SYNERGY_ROUTE__)
  return cachedPrefix
}

export function assetPath(path: string) {
  const prefix = proxyPrefix()
  return prefix ? `${prefix}${path}` : path
}
