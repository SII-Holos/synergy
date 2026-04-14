declare global {
  interface Window {
    __SYNERGY_ROUTE__?: string
  }
}

export function proxyPrefix() {
  const route = window.__SYNERGY_ROUTE__
  if (route != null) {
    const fullPath = window.location.pathname
    if (fullPath !== route && fullPath.endsWith(route)) {
      return fullPath.slice(0, fullPath.length - route.length).replace(/\/+$/, "")
    }
  }
  return ""
}

export function assetPath(path: string) {
  const prefix = proxyPrefix()
  return prefix ? `${prefix}${path}` : path
}
